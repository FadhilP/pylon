import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/pi-continuity.ts";
import { saveConfig } from "../src/config.ts";
import { archivalActivationDraft, emptyMemoryState, isMemoryState, isNotebookNote, isReviewRecord, serverNoteId, serverReviewId, sha256, type NotebookNote, type ReviewRecord } from "../src/memory.ts";
import type { ActivationDraft } from "../src/memory-activation.ts";
import { writeJsonAtomic } from "../src/storage.ts";
import { projectContext, worktreeFingerprint } from "../src/worktree.ts";

const exec = promisify(execFile);
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "continuity-extension-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(isolatedAgentDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "timed out waiting for asynchronous extension action");
}

const generatedWriteDraft = (): ActivationDraft => ({
  classification: "grounded", subscriptions: ["before_tool_call"],
  predicate: { all: [{ fact: "tool.name", op: "eq", value: "edit" }, { fact: "file.path", op: "matchesGlob", value: "src/generated/**" }] },
  delivery: "warn", lifecycle: { activateUntil: "task_complete", rearmOn: ["context_compacted"] },
  examples: {
    positive: [{ event: "before_tool_call", facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" } }],
    hardNegative: [{ event: "before_tool_call", facts: { "tool.name": "edit", "file.path": "src/source/client.ts" } }],
  },
});
const formatCommandDraft = (): ActivationDraft => ({
  classification: "grounded", subscriptions: ["before_tool_call", "after_tool_result"],
  predicate: { all: [{ fact: "tool.name", op: "eq", value: "bash" }, { fact: "tool.command", op: "startsWith", value: "dart format" }] },
  delivery: "warn", lifecycle: { activateUntil: "event_complete", rearmOn: [] },
  examples: {
    positive: [{ event: "before_tool_call", facts: { "tool.name": "bash", "tool.command": "dart format lib" } }],
    hardNegative: [{ event: "before_tool_call", facts: { "tool.name": "bash", "tool.command": "echo dart format" } }],
  },
});
const activatedNote = (overrides: Partial<NotebookNote> = {}): NotebookNote => ({
  id: serverNoteId(), scope: "user", owner: "default", trigger: "editing generated files", guidance: "Edit the generator instead.", authority: "user_instruction", origin: "agent", sourceRefs: [{ type: "direct_user_edit" }],
  disposition: "eligible_advisory", enforcementAuthority: "warning", activationDraft: generatedWriteDraft(), rawProposal: { trigger: "editing generated files", guidance: "Edit the generator instead." }, rewriteCharacter: "format_only",
  revision: 1, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", ...overrides,
});

function runtime(initialActive = ["read", "edit", "continuity_update"]) {
  let active = [...initialActive];
  let thinking = "medium";
  let selectedModel: any;
  let modelSelections = 0;
  const appended: Array<{ customType: string; data: any }> = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const sent: string[] = [];
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let sendHook: ((message: string) => void) | undefined;
  let appendFailure: Error | undefined;
  const pi: any = {
    events: {
      emit: (channel: string, value: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
      on: (channel: string, listener: (value: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener); listeners.set(channel, set);
        return () => set.delete(listener);
      },
    },
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => { active = [...next]; },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: any) => {
      if (appendFailure) { const error = appendFailure; appendFailure = undefined; throw error; }
      appended.push({ customType, data });
    },
    setModel: async (model: any) => {
      selectedModel = model;
      modelSelections++;
      return true;
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (next: string) => { thinking = next; },
    sendUserMessage: (message: string) => {
      sent.push(message);
      sendHook?.(message);
    },
    sendMessage: (message: any, options: any) => customMessages.push({ message, options }),
  };
  extension(pi);
  return {
    handlers,
    tools,
    commands,
    appended,
    customMessages,
    sent,
    selectedModel: () => selectedModel,
    modelSelections: () => modelSelections,
    thinking: () => thinking,
    active: () => [...active],
    loadAgain: () => extension(pi),
    onSendUserMessage: (hook: (message: string) => void) => { sendHook = hook; },
    failNextAppend: (error = new Error("append failed")) => { appendFailure = error; },
    emit: (channel: string, value: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
  };
}

test("package settings disable durable memory while keeping planning and recall", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-disabled-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await saveConfig({ version: 2, memoryEnabled: false });
    const app = runtime(["read", "memory", "continuity_recall", "continuity_update"]);
    const ctx: any = {
      cwd, hasUI: false, mode: "json",
      sessionManager: {
        getSessionId: () => "memory-disabled",
        getSessionFile: () => undefined,
        getEntries: () => [], getBranch: () => [], buildContextEntries: () => [],
      },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    assert.equal(app.active().includes("memory"), false);
    assert.equal(app.active().includes("continuity_recall"), true);
    assert.equal(app.active().includes("continuity_update"), true);
    const result = await app.tools.get("memory").execute("stale", { action: "list" }, undefined, undefined, ctx);
    assert.equal(result.details.memoryError, true);
    assert.match(result.content[0].text, /disabled in package settings/i);
    const beforeAgentStart = app.handlers.get("before_agent_start")![0];
    assert.equal(await beforeAgentStart({}, ctx), undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("V5 notes migrate losslessly to archival V6 without prompt-similarity activation", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-v5-migration-"));
  const cwd = join(root, "repo"), agentDir = join(root, "agent"), now = new Date().toISOString();
  await mkdir(cwd); process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    const v5Path = join(agentDir, "pi-continuity", "memory-v5", "state.json");
    await writeJsonAtomic(v5Path, {
      schemaVersion: 5, revision: 1, reviews: [], updatedAt: now,
      notes: [{ id: serverNoteId(), scope: "user", owner: "default", trigger: "package configuration changes", guidance: "Restart runtime services.", authority: "user_instruction", origin: "user", sourceRefs: [{ type: "direct_user_edit" }], revision: 1, createdAt: now, updatedAt: now }],
    });
    const rawV5 = await readFile(v5Path, "utf8");
    const app = runtime(), ctx: any = {
      cwd, hasUI: true, mode: "json",
      sessionManager: { getSessionId: () => "memory-migration", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [], buildContextEntries: () => [] },
      ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const migrated = JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "state.json"), "utf8"));
    assert.equal(migrated.schemaVersion, 6); assert.equal(migrated.notes[0].guidance, "Restart runtime services."); assert.equal(migrated.notes[0].disposition, "archival");
    assert.equal(JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "migration-v5.json"), "utf8")).status, "activated");
    assert.equal(await app.handlers.get("before_agent_start")![0]({ prompt: "package configuration runtime" }, ctx), undefined);
    const oldMemory = { role: "custom", customType: "pi-continuity-memory", content: "legacy lexical injection", details: { version: 1 } };
    const result = await app.handlers.get("context")![0]({ messages: [oldMemory, { role: "user", content: "request" }] }, ctx);
    assert.deepEqual(result.messages.filter((message: any) => message.customType === "pi-continuity-memory"), []);
    await app.commands.get("memory").handler("rollback", ctx);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "state.json"), "utf8")).notes, []);
    assert.equal(JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "migration-v5.json"), "utf8")).status, "rolled_back");
    assert.equal(await readFile(v5Path, "utf8"), rawV5);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("grounded rules activate from typed tool events without interrupting the action", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-event-"));
  const cwd = join(root, "repo"), agentDir = join(root, "agent"), memory = activatedNote();
  const commandMemory = activatedNote({ id: serverNoteId(), trigger: "running Dart formatting", guidance: "Do not run Dart format.", activationDraft: formatCommandDraft(), rawProposal: { trigger: "running Dart formatting", guidance: "Do not run Dart format." } });
  await mkdir(cwd); process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    await writeJsonAtomic(join(agentDir, "pi-continuity", "memory-v6", "state.json"), { ...emptyMemoryState(), revision: 1, notes: [memory, commandMemory], updatedAt: new Date().toISOString() });
    const app = runtime(["read", "edit", "continuity_update"]), ctx: any = {
      cwd, hasUI: false, mode: "json",
      sessionManager: { getSessionId: () => "memory-event", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [], buildContextEntries: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const toolCall = app.handlers.get("tool_call")![0];
    assert.equal(await toolCall({ toolName: "edit", toolCallId: "source", input: { path: "src/source/client.ts" } }, ctx), undefined);
    assert.equal(app.customMessages.length, 0, "hard negative produces no intervention");
    assert.equal(await toolCall({ toolName: "edit", toolCallId: "generated", input: { path: "src/generated/client.ts" } }, ctx), undefined);
    assert.equal(app.customMessages.length, 1); assert.match(app.customMessages[0]!.message.content, /Edit the generator instead/); assert.equal(app.customMessages[0]!.options.deliverAs, "steer");
    assert.equal(await toolCall({ toolName: "edit", toolCallId: "generated-sibling", input: { path: "src/generated/other.ts" } }, ctx), undefined);
    assert.equal(app.customMessages.length, 1, "a visible event-complete memory is not queued again for a sibling tool call");
    assert.equal(await toolCall({ toolName: "read", toolCallId: "sibling", input: { path: "README.md" } }, ctx), undefined, "unrelated siblings are never blocked");
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    assert.equal(await toolCall({ toolName: "bash", toolCallId: "format", input: { command: `dart format lib --token=${credential}` } }, ctx), undefined);
    assert.equal(app.customMessages.length, 2); assert.match(app.customMessages[1]!.message.content, /Do not run Dart format/);
    await app.handlers.get("tool_result")![0]({ toolName: "bash", toolCallId: "format", input: { command: `dart format lib --token=${credential}` }, content: [], details: { exitCode: 0 }, isError: false }, ctx);
    assert.equal(app.customMessages.length, 2, "before/result hooks deduplicate by causal tool call");
    assert.doesNotMatch(JSON.stringify({ appended: app.appended, messages: app.customMessages }), new RegExp(credential));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("changed project evidence suppresses new activation and active reinjection", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-freshness-"));
  const cwd = join(root, "repo"), agentDir = join(root, "agent"), excerpt = "Generated files must be edited through the generator.";
  await mkdir(cwd); await exec("git", ["init", "-q"], { cwd }); await writeFile(join(cwd, "README.md"), `${excerpt}\n`); process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    const owner = (await projectContext(cwd, "fallback")).owner, reviewId = serverReviewId(), excerptSha256 = sha256(excerpt);
    const memory = activatedNote({ scope: "project", owner, authority: "project_contract", sourceRefs: [{ type: "repository", path: "README.md", excerptSha256 }], sourceReviewId: reviewId });
    const operation = { operation: "add" as const, noteId: memory.id, scope: memory.scope, owner, trigger: memory.trigger, guidance: memory.guidance, authority: "project_contract" as const, sourceRefs: memory.sourceRefs, disposition: memory.disposition, enforcementAuthority: memory.enforcementAuthority, activationDraft: memory.activationDraft!, rawProposal: memory.rawProposal!, rewriteCharacter: memory.rewriteCharacter! };
    const review: ReviewRecord = { reviewId, sessionId: "source", toolCallId: "source", projectOwner: owner, reviewedAt: memory.createdAt, status: "committed", verificationStatus: { status: "verified", verifiedAt: memory.createdAt, sourceSnapshotId: sha256(excerptSha256) }, operations: [operation], rejectionCounts: {}, generation: 1, taskGeneration: 1, evidenceBatches: [[{ path: "README.md", start: 1, end: 1, excerptSha256 }]], settledAt: memory.createdAt };
    assert.equal(isReviewRecord(review), true);
    await writeJsonAtomic(join(agentDir, "pi-continuity", "memory-v6", "state.json"), { ...emptyMemoryState(), revision: 1, notes: [memory], reviews: [review], updatedAt: new Date().toISOString() });
    const app = runtime(["edit", "continuity_update"]), ctx: any = {
      cwd, hasUI: false, mode: "json",
      sessionManager: { getSessionId: () => "memory-freshness", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [], buildContextEntries: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const toolCall = app.handlers.get("tool_call")![0], toolResult = app.handlers.get("tool_result")![0];
    await toolCall({ toolName: "edit", toolCallId: "first", input: { path: "src/generated/client.ts" } }, ctx); assert.equal(app.customMessages.length, 1);
    await writeFile(join(cwd, "README.md"), "Contract changed.\n");
    await toolResult({ toolName: "edit", toolCallId: "contract-change", input: { path: "README.md" }, content: [], details: {}, isError: false }, ctx);
    for (const handler of app.handlers.get("session_compact") ?? []) await handler({}, ctx); assert.equal(app.customMessages.length, 1, "stale active rule is not reinjected");
    for (const handler of app.handlers.get("input") ?? []) handler({ source: "interactive", text: "new task" });
    await toolCall({ toolName: "edit", toolCallId: "after-change", input: { path: "src/generated/new.ts" } }, ctx); assert.equal(app.customMessages.length, 1, "stale rule is removed from the runtime index");
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("active advisory delivery rearms after compaction and resets at a new task", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-lifecycle-"));
  const cwd = join(root, "repo"), agentDir = join(root, "agent"), memory = activatedNote();
  await mkdir(cwd); process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    await writeJsonAtomic(join(agentDir, "pi-continuity", "memory-v6", "state.json"), { ...emptyMemoryState(), revision: 1, notes: [memory], updatedAt: new Date().toISOString() });
    let branch: any[] = [];
    const app = runtime(["edit", "continuity_update"]), ctx: any = {
      cwd, hasUI: false, mode: "json", signal: undefined,
      sessionManager: { getSessionId: () => "memory-lifecycle", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => branch, buildContextEntries: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const toolCall = app.handlers.get("tool_call")![0];
    await toolCall({ toolName: "edit", toolCallId: "first", input: { path: "src/generated/client.ts" } }, ctx);
    assert.equal(app.customMessages.length, 1);
    await toolCall({ toolName: "edit", toolCallId: "same-task", input: { path: "src/generated/other.ts" } }, ctx);
    assert.equal(app.customMessages.length, 1, "visible active memory is not repeated");
    branch = app.appended.map((entry) => ({ type: "custom", ...entry }));
    for (const handler of app.handlers.get("session_tree") ?? []) await handler({}, ctx);
    for (const handler of app.handlers.get("session_compact") ?? []) await handler({}, ctx);
    assert.equal(app.customMessages.length, 2); assert.match(app.customMessages[1]!.message.content, /Edit the generator instead/);
    for (const handler of app.handlers.get("input") ?? []) handler({ source: "interactive", text: "new task" });
    await toolCall({ toolName: "edit", toolCallId: "new-task", input: { path: "src/generated/new.ts" } }, ctx);
    assert.equal(app.customMessages.length, 2, "a new task does not duplicate a rule that remains visible in the same context epoch");
    assert.ok(app.appended.some((entry) => entry.customType === "pi-continuity-memory-ledger-v1"));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("manual and automatic compaction always use deterministic Continuity output", async () => {
  await saveConfig({ version: 2, memoryEnabled: true });
  const app = runtime();
  const compact = app.handlers.get("session_before_compact")![0];
  const message = (id: string, role: string, text: string, parentId: string | null) => ({
    id, parentId, type: "message", timestamp: Date.now(),
    message: { role, content: [{ type: "text", text }], timestamp: Date.now() },
  });
  const branch = [
    message("old-user", "user", "Keep old sessions compatible", null),
    message("old-assistant", "assistant", "Use deterministic extraction", "old-user"),
    message("current", "user", "Current request", "old-assistant"),
    message("suffix", "assistant", "Current response", "current"),
  ];
  const event = (reason: string, customInstructions?: string, signal = new AbortController().signal) => ({
    branchEntries: branch,
    preparation: { firstKeptEntryId: "suffix", tokensBefore: 42_000, settings: { keepRecentTokens: 1 } },
    reason, willRetry: false, customInstructions, signal,
  });
  const notices: string[] = [];
  const ctx: any = {
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
    ui: { notify: (text: string) => notices.push(text) },
  };

  for (const reason of ["manual", "threshold"]) {
    const result = await compact(event(reason), ctx);
    assert.equal(result.compaction.details.mode, "generic");
    assert.match(result.compaction.summary, /Deterministic Transcript Context/);
  }
  assert.deepEqual(await compact(event("manual", undefined, AbortSignal.abort()), ctx), { cancel: true });
  assert.deepEqual(notices, []);

  assert.deepEqual(await compact(event("manual", "focus on decisions"), ctx), { cancel: true });
  assert.deepEqual(notices, ["Compaction cancelled because Continuity could not produce deterministic output."]);

  await saveConfig({ version: 2, memoryEnabled: true, compactionReviewer: { model: "provider/reviewer" } });
  const fallback = await compact(event("manual"), ctx);
  assert.equal(fallback.compaction.details.mode, "generic");
  assert.equal(fallback.compaction.details.supplements.length, 0);
});

test("Continuity retained-token setting overrides a cloned Pi preparation", async () => {
  await saveConfig({ version: 2, memoryEnabled: true, keepRecentTokens: 1_000 });
  const app = runtime();
  const compact = app.handlers.get("session_before_compact")![0];
  const message = (id: string, role: string, text: string, parentId: string | null) => ({
    id, parentId, type: "message", timestamp: Date.now(),
    message: { role, content: [{ type: "text", text }], timestamp: Date.now() },
  });
  const branch = [
    message("current", "user", "Current request", null),
    message("suffix-1", "assistant", "x".repeat(20_000), "current"),
    message("suffix-2", "assistant", "y".repeat(20_000), "suffix-1"),
  ];
  const preparation = {
    firstKeptEntryId: "current",
    tokensBefore: 42_000,
    settings: { keepRecentTokens: 50_000 },
  };
  for (const reason of ["manual", "threshold"]) {
    const result = await compact({
      branchEntries: branch,
      preparation,
      reason,
      willRetry: false,
      signal: new AbortController().signal,
    }, { modelRegistry: { find: () => undefined }, ui: { notify: () => {} } });
    assert.equal(result.compaction.firstKeptEntryId, "suffix-2");
    assert.equal(preparation.settings.keepRecentTokens, 50_000, "incoming Pi preparation remains unchanged");
  }
});

test("over-threshold tool work compacts and resumes through public extension APIs", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-mid-task-compact-"));
  const cwd = join(root, "repo"), agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: false, keepRecentTokens: 50_000 });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: true, reserveTokens: 30_000 },
    }));
    const app = runtime();
    const compactCalls: any[] = [];
    const ctx: any = {
      cwd, hasUI: false, mode: "json", signal: new AbortController().signal,
      isIdle: () => true,
      isProjectTrusted: () => false,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 250_000, contextWindow: 272_000, percent: 91.9 }),
      compact: (options: any) => compactCalls.push(options),
      sessionManager: {
        getSessionId: () => "mid-task-session", getSessionFile: () => undefined,
        getEntries: () => [], getBranch: () => [], buildContextEntries: () => [],
      },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const turnCtx = { ...ctx };
    assert.notEqual(turnCtx, ctx);
    for (const handler of app.handlers.get("tool_execution_end") ?? [])
      await handler({ toolCallId: "call-1", result: { terminate: false } }, turnCtx);
    for (const handler of app.handlers.get("turn_end") ?? []) await handler({
      message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
      toolResults: [{ role: "toolResult", toolCallId: "call-1" }],
    }, turnCtx);

    assert.equal(compactCalls.length, 1, "custom reserveTokens threshold should trigger before Pi's default threshold");
    const duplicateAutoCompact = await app.handlers.get("session_before_compact")![0]({ reason: "threshold" }, ctx);
    assert.deepEqual(duplicateAutoCompact, { cancel: true });
    assert.equal(app.customMessages.length, 0);
    compactCalls[0].onComplete();
    assert.equal(app.customMessages.length, 1);
    assert.deepEqual(app.customMessages[0].options, { triggerTurn: true });
    assert.equal(app.customMessages[0].message.customType, "pi-continuity-resume");
    assert.equal(app.customMessages[0].message.display, false);
    assert.match(app.customMessages[0].message.content, /Continue the unfinished task/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("mid-task compaction respects termination, cancellation, pending input, failure, and shutdown", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-mid-task-guards-"));
  const cwd = join(root, "repo"), agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: false });
    const app = runtime();
    const compactCalls: any[] = [];
    let pending = false, compactThrows = false;
    const ctx: any = {
      cwd, hasUI: false, mode: "json", signal: new AbortController().signal,
      isIdle: () => true,
      isProjectTrusted: () => false,
      hasPendingMessages: () => pending,
      getContextUsage: () => ({ tokens: 260_000, contextWindow: 272_000, percent: 95.6 }),
      compact: (options: any) => {
        if (compactThrows) throw Error("synchronous compact failure");
        compactCalls.push(options);
      },
      sessionManager: {
        getSessionId: () => "guarded-mid-task-session", getSessionFile: () => undefined,
        getEntries: () => [], getBranch: () => [], buildContextEntries: () => [],
      },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    const finishToolTurn = async (id: string, terminate = false) => {
      for (const handler of app.handlers.get("tool_execution_end") ?? [])
        await handler({ toolCallId: id, result: { terminate } }, ctx);
      for (const handler of app.handlers.get("turn_end") ?? []) await handler({
        message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "read", arguments: {} }] },
        toolResults: [{ role: "toolResult", toolCallId: id }],
      }, ctx);
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);

    for (const handler of app.handlers.get("turn_end") ?? []) await handler({
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      toolResults: [{ role: "toolResult", toolCallId: "not-a-tool-turn" }],
    }, ctx);
    await finishToolTurn("terminating", true);
    pending = true;
    await finishToolTurn("pending");
    pending = false;
    ctx.signal = AbortSignal.abort();
    await finishToolTurn("cancelled");
    ctx.signal = new AbortController().signal;
    assert.equal(compactCalls.length, 0);

    await finishToolTurn("newer-input");
    assert.equal(compactCalls.length, 1);
    for (const handler of app.handlers.get("input") ?? [])
      await handler({ source: "interactive", text: "Stop and reconsider" }, ctx);
    compactCalls[0].onComplete();
    assert.equal(app.customMessages.length, 0);

    await finishToolTurn("failed-compaction");
    assert.equal(compactCalls.length, 2);
    compactCalls[1].onError(new Error("failed"));
    assert.equal(app.customMessages.length, 0);

    compactThrows = true;
    await finishToolTurn("synchronous-failure");
    compactThrows = false;
    assert.equal(compactCalls.length, 2);

    await finishToolTurn("shutdown");
    assert.equal(compactCalls.length, 3);
    for (const handler of app.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    compactCalls[2].onComplete();
    assert.equal(app.customMessages.length, 0);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("continuity and memory guidance stay dedicated", () => {
  const app = runtime();
  const continuity = app.tools.get("continuity_update");
  const memory = app.tools.get("memory");
  const guidance = continuity.promptGuidelines.join("\n");
  const memoryGuidance = memory.promptGuidelines.join("\n");
  assert.match(continuity.promptSnippet, /planning.*todo\/state.*clarification/i);
  assert.match(guidance, /Use set_plan for explicit \/plan/i);
  assert.match(guidance, /skip it for straightforward read-only work and one-shot local fixes/i);
  assert.match(guidance, /2–4 outcome-level todos/i);
  assert.match(guidance, /blocking user decision/i);
  assert.match(guidance, /sole tool call at a safe checkpoint/i);
  assert.match(guidance, /Never re-ask an answered question without new evidence/i);
  assert.match(guidance, /recommended option first/i);
  assert.match(guidance, /planSummary.*compact executor handoff/i);
  assert.match(guidance, /concrete paths\/symbols/i);
  assert.match(guidance, /assumptions or gaps/i);
  assert.match(guidance, /acceptance criteria/i);
  assert.match(guidance, /Continuity owns plan presentation/i);
  assert.match(guidance, /internal task list/i);
  assert.match(guidance, /Keep verification out of new todo lists/i);
  assert.match(guidance, /sole verification-only todo completes automatically/i);
  assert.match(guidance, /every Continuity update tool-only and before final text/i);
  assert.match(guidance, /Never call a completion tool/i);
  assert.match(guidance, /exactly one text-only final response/i);
  assert.match(guidance, /acknowledge allowUnverified tool-only/i);
  assert.match(guidance, /disclose the limitation/i);
  assert.match(guidance, /After failed, stale, cancelled, or error Verify results/i);
  assert.match(guidance, /one caveated text-only final response and stop without another tool call/i);
  assert.ok(guidance.length < 1_000);
  assert.doesNotMatch(guidance, /memory|durable/i);
  assert.deepEqual(continuity.parameters.properties.action.enum, ["clarify", "set_plan", "todo", "state"]);
  assert.equal(continuity.parameters.properties.completion, undefined);
  assert.match(continuity.parameters.properties.allowUnverified.description, /tool-only state update/i);
  assert.match(continuity.parameters.properties.allowUnverified.description, /disclose the limitation/i);
  for (const field of ["key", "kind", "text", "source", "confidence", "scope", "evidencePaths"])
    assert.equal(continuity.parameters.properties[field], undefined);
  assert.equal(continuity.parameters.properties.todoIds.maxItems, 12);
  assert.equal(memory.label, "Memory");
  assert.equal(memory.executionMode, "sequential");
  assert.match(JSON.stringify(memory.parameters), /list.*propose/);
  assert.doesNotMatch(JSON.stringify(memory.parameters), /confidence|kind/);
  assert.match(memory.promptSnippet, /reviewer-gated/i);
  assert.doesNotMatch(memoryGuidance, /Most tasks should propose no memory/i);
  assert.match(memoryGuidance, /potentially reusable/i);
  assert.match(memoryGuidance, /explicitly stated user preferences or instructions/i);
  assert.match(memoryGuidance, /intentional project conventions or contracts/i);
  assert.match(memoryGuidance, /could plausibly guide a future session/i);
  assert.match(memoryGuidance, /Do not require certainty of admission/i);
  assert.match(memoryGuidance, /accept, rewrite, merge, defer, or reject/i);
  assert.match(memoryGuidance, /progress, implementation summaries, guesses, generic advice, one-off details, duplicates, or secrets/i);
  assert.match(memoryGuidance, /at most two proposals/i);
  assert.match(memoryGuidance, /exact quote/i);
  assert.match(memoryGuidance, /at most three exact repository ranges/i);
  assert.match(memoryGuidance, /120 lines/i);
  assert.equal(memory.parameters.properties.query.maxLength, 500);
  assert.ok(memoryGuidance.length < 1_200);
});

test("session recall tool is sequential, read-only, and handles ephemeral state without side effects", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-recall-extension-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let persisted = false;
  let getEntriesCalls = 0;
  const visible = [{
    id: "visible",
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: { role: "user", content: "Visible evidence", timestamp: Date.now() },
  }];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: {
      getSessionId: () => "recall-session",
      getSessionFile: () => persisted ? join(root, "session.jsonl") : undefined,
      getEntries: () => { getEntriesCalls++; return visible; },
      getBranch: () => visible,
      buildContextEntries: () => visible,
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    const recall = app.tools.get("continuity_recall");
    assert.equal(recall.executionMode, "sequential");
    assert.match(recall.description, /historical evidence/i);
    assert.match(recall.description, /not an exact historical session-ID lookup.*search_sessions/i);
    assert.match(recall.promptGuidelines.join("\n"), /Never use project_sessions to locate an exact historical session ID.*sessionId.*requested subject as query/i);
    assert.match(JSON.stringify(recall.parameters), /execution.*lineage.*all.*project_sessions.*text.*files.*touched.*since.*before/);
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);

    const historical = SessionManager.create(cwd);
    historical.appendMessage({ role: "user", content: "Historical project-session marker", timestamp: Date.now() });
    historical.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Historical response" }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const projectRecall = await recall.execute(
      "project-recall",
      { scope: "project_sessions", query: "project-session marker" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(projectRecall.content[0].text, /Historical project-session marker/);
    assert.equal(projectRecall.details.effectiveScope, "project_sessions");
    assert.equal(projectRecall.details.sessionsSearched, 1);
    assert.equal(app.appended.length, 0);
    assert.equal(app.customMessages.length, 0);

    await app.tools.get("continuity_update").execute(
      "plan",
      { action: "set_plan", goal: "Recall", todos: ["Recall history"] },
      undefined,
      undefined,
      ctx,
    );

    const ephemeral = await recall.execute("recall", {}, undefined, undefined, ctx);
    assert.match(ephemeral.content[0].text, /ephemeral.*no persisted history/i);

    persisted = true;
    const callsBefore = getEntriesCalls;
    const appendedBefore = app.appended.length;
    const messagesBefore = app.customMessages.length;
    const downgraded = await recall.execute("recall", { scope: "all" }, undefined, undefined, ctx);
    assert.match(downgraded.content[0].text, /effective scope: visible/);
    assert.deepEqual(downgraded.details, {
      recall: true,
      requestedScope: "all",
      effectiveScope: "visible",
      page: 1,
      collected: 1,
      hasMore: false,
    });
    assert.equal(getEntriesCalls, callsBefore, "all entries must not be read before boundary proof");
    assert.equal(app.appended.length, appendedBefore);
    assert.equal(app.customMessages.length, messagesBefore);

  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("state rejects todo fields before mutation or circuit breaking", async () => {
  const tool = runtime().tools.get("continuity_update");
  for (const [field, value] of [
    ["todoId", "todo_1"],
    ["todoIds", ["todo_1"]],
    ["status", "done"],
    ["nextTodoId", "todo_2"],
  ] as const) {
    const result = await tool.execute("invalid", { action: "state", [field]: value }, undefined, undefined, {});
    assert.match(result.content[0].text, new RegExp(`^${field} require action \\"todo\\"`));
    assert.equal(result.terminate, undefined);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await tool.execute("repeated", {
      action: "state", todoIds: ["todo_1"], status: "done",
    }, undefined, undefined, {});
    assert.match(result.content[0].text, /^todoIds, status require action "todo"/);
    assert.equal(result.details?.circuitBreaker, undefined);
  }
  const valid = await tool.execute("valid", { action: "state" }, undefined, undefined, {});
  assert.match(valid.content[0].text, /No active work/);
});

test("failed legacy completion after final prose terminates without a duplicate reply", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-legacy-completion-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let content: any[] = [];
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: {
      getSessionId: () => "legacy-completion-session",
      getEntries: () => [],
      getLeafEntry: () => ({ type: "message", message: { role: "assistant", content } }),
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Inspect", todos: ["Answer"] }, undefined, undefined, ctx);

    content = [
      { type: "text", text: "Final answer" },
      { type: "toolCall", id: "complete-with-reply", name: "continuity_update" },
    ];
    const stopped = await tool.execute(
      "complete-with-reply", { action: "state", completion: true }, undefined, undefined, ctx,
    );
    assert.match(stopped.content[0].text, /Cannot complete while todos remain/);
    assert.equal(stopped.terminate, true);

    content = [{ type: "toolCall", id: "complete-tool-only", name: "continuity_update" }];
    const recoverable = await tool.execute(
      "complete-tool-only", { action: "state", completion: true }, undefined, undefined, ctx,
    );
    assert.match(recoverable.content[0].text, /Cannot complete while todos remain/);
    assert.equal(recoverable.terminate, undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("text-only final response automatically completes ready work", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-auto-complete-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "auto-complete-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Inspect", todos: ["Answer"] }, undefined, undefined, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    const messageEnd = app.handlers.get("message_end")?.[0];

    await messageEnd?.({ message: {
      role: "assistant", stopReason: "toolUse",
      content: [
        { type: "text", text: "Not final" },
        { type: "toolCall", id: "call", name: "read", arguments: {} },
      ],
    } }, ctx);
    let context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    await messageEnd?.({ message: {
      role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Not final" }],
    } }, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    await messageEnd?.({ message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }],
    } }, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.equal(context, undefined);
    const repeated = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(repeated.content[0].text, /already completed/i);
    assert.equal(repeated.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("automatic completion waits for required verification", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-auto-verify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "auto-verify-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Change", todos: ["Ship"] }, undefined, undefined, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    const finalMessage = { message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }],
    } };
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    let blocked = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);

    app.emit("pi-verify:result", {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "failed", runId: "failed",
      results: [{ command: "npm test", code: 1 }],
    });
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    assert.deepEqual(app.sent, [], "failed Verify final must not schedule another turn");
    let context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);
    assert.match(context.messages.at(-1).content, /Verification failed/);
    blocked = await tool.execute("complete", { action: "state", completion: true, allowUnverified: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);
    assert.equal(blocked.terminate, undefined);

    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "passed", runId: "run", results: [] });
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    blocked = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /already completed/i);
    assert.equal(blocked.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("verification clears only its own blocker state", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-issue-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "verify-issue-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Change", todos: ["Ship"] }, undefined, undefined, ctx);
    const context = async () => (await app.handlers.get("context")?.[0]({ messages: [] }, ctx))
      .messages.at(-1).content;

    app.emit("pi-verify:result", {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd,
      state: "failed", runId: "failed", results: [{ command: "npm test", code: 1 }],
    });
    assert.match(await context(), /Verification failed/);

    await tool.execute("manual", {
      action: "state", latestFailure: "Manual blocker", nextAction: "Wait for user",
    }, undefined, undefined, ctx);
    app.emit("pi-verify:result", {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd,
      state: "passed", runId: "passed", results: [],
    });
    assert.match(await context(), /Blocked: Manual blocker/);
    assert.match(await context(), /Next: Wait for user/);

    await tool.execute("clear", {
      action: "state", latestFailure: "", nextAction: "",
    }, undefined, undefined, ctx);
    app.emit("pi-verify:result", {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd,
      state: "failed", runId: "failed-again", results: [],
    });
    assert.match(await context(), /Verification failed/);
    app.emit("pi-verify:result", {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd,
      state: "clean", runId: "clean", results: [],
    });
    assert.doesNotMatch(await context(), /Verification failed/);

    app.emit("pi-heartbeat:job", {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd,
      state: "failed", id: "job-1", todoId: "todo_1",
    });
    assert.match(await context(), /Background job job-1 failed/);
    app.emit("pi-heartbeat:job", {
      version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd,
      state: "completed", id: "job-1", todoId: "todo_1",
    });
    assert.doesNotMatch(await context(), /Background job job-1 failed/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("clean Verify requires a tool-only acknowledgement before automatic completion", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-acknowledgement-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "verify-acknowledgement-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Change", todos: ["Ship"] }, undefined, undefined, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    const finalMessage = { message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }],
    } };
    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "failed", runId: "failed", results: [] });
    let rejected = await tool.execute(
      "failed-ack", { action: "state", allowUnverified: true }, undefined, undefined, ctx,
    );
    assert.match(rejected.content[0].text, /requires a current clean or no_checks/);

    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "clean", runId: "clean", results: [] });
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    let context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    rejected = await tool.execute(
      "bad-ack", { action: "todo", todoId: "todo_1", status: "done", allowUnverified: true },
      undefined, undefined, ctx,
    );
    assert.match(rejected.content[0].text, /allowUnverified requires action "state"/);

    const acknowledged = await tool.execute(
      "ack", { action: "state", allowUnverified: true }, undefined, undefined, ctx,
    );
    assert.match(acknowledged.content[0].text, /Continuity state updated/);
    assert.equal(acknowledged.terminate, undefined);

    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit-after-ack", input: {} }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit-after-ack", input: {} }, ctx);
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "no_checks", runId: "no-checks", results: [] });
    await tool.execute("ack-again", { action: "state", allowUnverified: true }, undefined, undefined, ctx);
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.equal(context, undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("passing Verify completes a sole remaining verification todo", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verification-todo-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "verification-todo", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", {
      action: "set_plan", goal: "Ship", todos: ["Implement change", "Run final verification"],
    }, undefined, undefined, ctx);
    await tool.execute("done", {
      action: "todo", todoId: "todo_1", status: "done", nextTodoId: "todo_2",
    }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", input: {} }, ctx);

    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "passed", runId: "passed", results: [] });
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.doesNotMatch(context.messages.at(-1).content, /Todo todo_2/);

    await app.handlers.get("message_end")?.[0]?.({ message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }],
    } }, ctx);
    assert.equal(await app.handlers.get("context")?.[0]({ messages: [] }, ctx), undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("settlement waits for the single post-Verify final response", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-response-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "verify-response", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Ship", todos: ["Implement"] }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? []) await handler({ toolName: "edit", input: {} }, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "passed", runId: "passed", results: [] });
    await app.handlers.get("agent_settled")?.[0]?.({}, ctx);
    const completed = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /^Work completed/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("TUI keeps routine updates hidden but shows memory and terminal outcomes", () => {
  const app = runtime();
  const tool = app.tools.get("continuity_update");
  const memory = app.tools.get("memory");
  const theme = { fg: (_color: string, text: string) => text };
  const render = (text: string, details?: any) => tool.renderResult(
    { content: [{ type: "text", text }], details },
    {},
    theme,
  ).render(80).map((line: string) => line.trimEnd()).join("\n");
  const renderMemory = (text: string, details?: any) => memory.renderResult(
    { content: [{ type: "text", text }], details },
    {},
    theme,
  ).render(80).map((line: string) => line.trimEnd()).join("\n");
  assert.equal(render("Continuity state updated."), "");
  assert.match(render("Work completed. No further continuity updates needed."), /Task completed/);
  assert.match(render("Cannot complete while todos remain."), /Cannot complete while todos remain/);
  assert.match(render("Continuity circuit breaker stopped 3 identical calls within 30 seconds."), /loop stopped/);
  assert.equal(
    render("Small", { clarification: { question: "Pick scope?", answer: "Small" } }),
    "? Pick scope?\nSmall",
  );
  assert.match(
    renderMemory("Memory candidate add queued: project/workflow.test.", {
      memoryCandidate: { action: "add", scope: "project", key: "workflow.test" },
    }),
    /Memory candidate add queued: project\/workflow\.test/,
  );
  assert.match(
    renderMemory("memory remove requires nonempty source/reason evidence", { memoryError: true }),
    /memory remove requires/i,
  );
  assert.match(
    renderMemory("Stored facts:\n- project/workflow.test: Run tests", { memoryList: true }),
    /project\/workflow\.test: Run tests/,
  );
});

test("circuit breaker aborts the third identical call within 30 seconds", async () => {
  const tool = runtime().tools.get("continuity_update");
  let aborts = 0;
  const ctx = { abort: () => { aborts++; } };
  const params = { action: "state", completion: true };
  const first = await tool.execute("call-1", params, undefined, undefined, ctx);
  const second = await tool.execute("call-2", params, undefined, undefined, ctx);
  const third = await tool.execute("call-3", params, undefined, undefined, ctx);
  assert.equal(first.terminate, undefined);
  assert.equal(second.terminate, undefined);
  assert.equal(third.terminate, true);
  assert.equal(third.details.circuitBreaker, true);
  assert.match(third.content[0].text, /3 identical calls within 30 seconds/);
  assert.equal(aborts, 1);
});

test("circuit breaker ignores distinct or expired calls", async () => {
  const oldNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const tool = runtime().tools.get("continuity_update");
    let aborts = 0;
    const ctx = { abort: () => { aborts++; } };
    await tool.execute("call-1", { action: "state", currentTodoId: "todo_1" }, undefined, undefined, ctx);
    await tool.execute("call-2", { action: "state", currentTodoId: "todo_2" }, undefined, undefined, ctx);
    await tool.execute("call-3", { action: "state", currentTodoId: "todo_3" }, undefined, undefined, ctx);
    const repeated = { action: "state", completion: true };
    await tool.execute("call-4", repeated, undefined, undefined, ctx);
    await tool.execute("call-5", repeated, undefined, undefined, ctx);
    now += 30_001;
    const expired = await tool.execute("call-6", repeated, undefined, undefined, ctx);
    assert.equal(expired.terminate, undefined);
    assert.equal(aborts, 0);
  } finally {
    Date.now = oldNow;
  }
});

test("set_plan canonicalizes invented IDs and creates executing todos without explicit plan mode", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-todos-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "todo-session" },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    const result = await app.tools.get("continuity_update").execute(
      "call", {
        action: "set_plan",
        goal: "Ship change",
        planSummary: "Implement safely, then run checks",
        constraints: [" Keep API stable ", "  "],
        planTodos: [
          { id: "todo_1", text: "Implement" },
          { id: "todo_1", text: "Verify" },
        ],
      }, undefined, undefined, ctx,
    );
    assert.match(result.content[0].text, /Executing task list stored/);
    assert.equal(result.details, undefined);
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);
    assert.match(context.messages.at(-1).content, /Current todo_1 \[in_progress\]: Implement/);
    assert.match(context.messages.at(-1).content, /Todo todo_2 \[pending\]: Verify/);

    const advanced = await app.tools.get("continuity_update").execute(
      "advance", {
        action: "todo",
        todoId: "todo_1",
        status: "done",
        nextTodoId: "todo_2",
      }, undefined, undefined, ctx,
    );
    assert.match(advanced.content[0].text, /state updated/i);
    const advancedContext = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(advancedContext.messages.at(-1).content, /Current todo_2 \[in_progress\]: Verify/);
    assert.match(advancedContext.messages.at(-1).content, /Done: 1/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("bulk todo completion is atomic and preserves the single-todo API", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-bulk-todos-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "bulk-todos-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", {
      action: "set_plan", goal: "Ship", todos: ["Inspect", "Implement", "Verify"],
    }, undefined, undefined, ctx);

    const snapshot = async () => (await app.handlers.get("context")?.[0]({ messages: [] }, ctx))
      .messages.at(-1).content;
    const before = await snapshot();
    for (const invalid of [
      { action: "todo", todoIds: ["todo_1", "todo_1"], status: "done" },
      { action: "todo", todoIds: ["todo_1", "missing"], status: "done" },
      { action: "todo", todoIds: ["todo_1"], status: "in_progress" },
      { action: "todo", todoIds: ["todo_2"], status: "done", nextTodoId: "todo_1" },
      { action: "todo", todoIds: ["todo_1", "todo_2"], status: "done", nextTodoId: "todo_2" },
    ]) {
      const rejected = await tool.execute("invalid", invalid, undefined, undefined, ctx);
      assert.match(rejected.content[0].text, /Unknown or invalid todo transition/);
      assert.equal(await snapshot(), before, "failed bulk validation must not mutate work");
    }

    const continuityRoot = join(root, "agent", "pi-continuity");
    const workspaces = JSON.parse(await readFile(join(continuityRoot, "workspaces.json"), "utf8"));
    const workspaceId = workspaces.find((item: any) => item.canonicalPath === cwd).id;
    const workPath = join(continuityRoot, "workspaces", workspaceId, "sessions", "bulk-todos-session.json");
    const durableBefore = await readFile(workPath, "utf8");
    await assert.rejects(tool.execute("unsafe", {
      action: "todo", todoIds: ["todo_1", "todo_2"], status: "done", nextTodoId: "todo_3",
      latestFailure: ["token", "unsafe-placeholder"].join("="),
    }, undefined, undefined, ctx), /candidate rejected: possible credential/);
    assert.equal(await snapshot(), before, "failed persistence must restore in-memory work");
    assert.equal(await readFile(workPath, "utf8"), durableBefore, "failed persistence must not change durable work");

    const completed = await tool.execute("bulk", {
      action: "todo", todoIds: ["todo_1", "todo_2"], status: "done", nextTodoId: "todo_3",
      latestFailure: "", nextAction: "Verify the result",
    }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /state updated/i);
    const after = await snapshot();
    assert.match(after, /Current todo_3 \[in_progress\]: Verify/);
    assert.match(after, /Done: 2/);
    assert.match(after, /Next: Verify the result/);

    // Existing callers retain the single todoId transition shape.
    const single = await tool.execute("single", {
      action: "todo", todoId: "todo_3", status: "done",
    }, undefined, undefined, ctx);
    assert.match(single.content[0].text, /state updated/i);
    assert.match(await snapshot(), /Done: 3/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("execution clarification is isolated, blocking, and cancellable", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-clarify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let leafContent: any[] = [];
  let aborts = 0;
  let selection: string | undefined;
  let customAnswer = "";
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    abort: () => { aborts++; },
    sessionManager: {
      getSessionId: () => "clarify-session",
      getEntries: () => [],
      getLeafEntry: () => ({
        type: "message",
        message: { role: "assistant", content: leafContent },
      }),
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => selection,
      input: async () => customAnswer,
      editor: async () => customAnswer,
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", {
      action: "set_plan", goal: "Ship", todos: ["Implement"],
    }, undefined, undefined, ctx);

    const clarifyCall = {
      type: "toolCall", id: "clarify", name: "continuity_update",
      arguments: { action: "clarify" },
    };
    const editCall = {
      type: "toolCall", id: "edit", name: "edit", arguments: {},
    };
    leafContent = [clarifyCall, editCall];
    for (const event of [
      { toolName: "continuity_update", toolCallId: "clarify", input: { action: "clarify" } },
      { toolName: "edit", toolCallId: "edit", input: {} },
    ]) {
      for (const guard of app.handlers.get("tool_call") ?? [])
        assert.match((await guard(event, ctx)).reason, /only tool call.*safe checkpoint/i);
    }

    leafContent = [clarifyCall];
    const params = {
      action: "clarify",
      question: "Which implementation?",
      options: [{ label: "Small" }, { label: "Full", description: "Broader change" }],
    };
    for (const guard of app.handlers.get("tool_call") ?? [])
      assert.equal(await guard({ toolName: "continuity_update", toolCallId: "clarify", input: params }, ctx), undefined);
    const prose = await tool.execute("clarify", params, undefined, undefined, ctx);
    assert.match(prose.content[0].text, /Ask user in prose and wait/);
    assert.match(prose.content[0].text, /1\. Small/);
    assert.match(prose.content[0].text, /2\. Full — Broader change/);
    assert.equal(prose.terminate, undefined);
    for (const guard of app.handlers.get("tool_call") ?? [])
      assert.match((await guard({ toolName: "read", toolCallId: "read", input: {} }, ctx)).reason, /Ask the pending clarification in prose and stop/i);
    await tool.execute("done", {
      action: "todo", todoId: "todo_1", status: "done",
    }, undefined, undefined, ctx);
    await app.handlers.get("message_end")?.[0]?.({ message: {
      role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Which implementation?" }],
    } }, ctx);
    const pendingContext = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(pendingContext.messages.at(-1).content, /Work: executing/);

    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    ctx.hasUI = true;
    ctx.mode = "tui";
    selection = undefined;
    const cancelled = await tool.execute("cancel", {
      ...params, question: "Continue or stop?",
    }, undefined, undefined, ctx);
    assert.match(cancelled.content[0].text, /Execution stopped/);
    assert.equal(cancelled.terminate, true);
    assert.equal(aborts, 1);

    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    selection = "Small";
    const answered = await tool.execute("answer", {
      ...params, question: "Pick scope?",
    }, undefined, undefined, ctx);
    assert.equal(answered.content[0].text, "Small");
    assert.deepEqual(answered.details.clarification, {
      question: "Pick scope?", answer: "Small",
    });
    selection = "Full — Broader change";
    const secondAnswer = await tool.execute("second-answer", {
      ...params, question: "Pick deployment scope?",
    }, undefined, undefined, ctx);
    assert.equal(secondAnswer.content[0].text, "Full — Broader change");
    assert.deepEqual(secondAnswer.details.clarification, {
      question: "Pick deployment scope?", answer: "Full — Broader change",
    });

    selection = "Write a different answer…";
    customAnswer = "Only API changes";
    const custom = await tool.execute("custom-answer", {
      ...params, question: "Any constraints?",
    }, undefined, undefined, ctx);
    assert.equal(custom.content[0].text, "Only API changes");
    assert.deepEqual(custom.details.clarification, {
      question: "Any constraints?", answer: "Only API changes",
    });
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("standalone and bulk clarification use the effective timeout without creating work", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-standalone-clarify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const app = runtime();
  const selectionOptions: Array<{ timeout?: number } | undefined> = [];
  const questionnaireOptions: Array<{ timeout?: number } | undefined> = [];
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "rpc",
    abort: () => assert.fail("standalone clarification must not abort"),
    sessionManager: {
      getSessionId: () => "standalone-clarify-session",
      getEntries: () => [],
      getLeafEntry: () => ({
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "clarify",
            name: "continuity_update",
            arguments: { action: "clarify" },
          }],
        },
      }),
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async (_title: string, _choices: string[], options?: { timeout?: number }) => {
        selectionOptions.push(options);
        return "Small";
      },
      input: async () => "Custom",
      questionnaire: async (questions: unknown[], options?: { timeout?: number }) => {
        questionnaireOptions.push(options);
        return questions.length === 1 ? ["Small"] : ["Small", "Later"];
      },
    },
  };
  try {
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    app.emit("pylon:runtime-policy", {
      version: 2,
      dialogTimeouts: { guard: 60, clarify: 120 },
    });
    const tool = app.tools.get("continuity_update");
    const single = await tool.execute("single", {
      action: "clarify",
      question: "Scope?",
      options: [{ label: "Small" }, { label: "Large" }],
    }, undefined, undefined, ctx);
    assert.equal(single.content[0].text, "Small");
    assert.deepEqual(selectionOptions, []);

    const bulk = await tool.execute("bulk", {
      action: "clarify",
      questions: [
        { question: "Scope?", options: [{ label: "Small" }, { label: "Large" }] },
        { question: "Deploy?", options: [{ label: "Now" }, { label: "Later" }] },
      ],
    }, undefined, undefined, ctx);
    assert.match(bulk.content[0].text, /1\. Scope\?/);
    assert.deepEqual(questionnaireOptions, [{ timeout: 120_000 }, { timeout: 120_000 }]);
    assert.equal(app.appended.some((entry) => entry.customType.includes("run")), false);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("read-only execution completion skips Verify", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-read-only-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "read-only-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("call", { action: "set_plan", goal: "Inspect", todos: ["Answer"] }, undefined, undefined, ctx);
    await tool.execute("call", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "cancelled", runId: "old-run", results: [] });
    const completed = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /Work completed.*No further continuity updates needed/);
    assert.equal(completed.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("shell tools require Verify only when the Git worktree changes", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-bash-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["config", "user.email", "continuity@test.local"], { cwd });
  await exec("git", ["config", "user.name", "continuity-test"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await exec("git", ["add", "tracked.txt"], { cwd });
  await exec("git", ["commit", "-qm", "base"], { cwd });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const context = (sessionId: string): any => ({
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  });
  try {
    for (const [sessionId, mutate, toolName] of [
      ["read-only-bash", false, "bash"],
      ["changed-bash", true, "bash"],
      ["read-only-grunt", false, "grunt"],
      ["changed-grunt", true, "grunt"],
    ] as const) {
      const app = runtime(), ctx = context(sessionId);
      for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
      const tool = app.tools.get("continuity_update");
      await tool.execute("plan", { action: "set_plan", goal: "Run command", todos: ["Finish"] }, undefined, undefined, ctx);
      for (const handler of app.handlers.get("tool_call") ?? [])
        await handler({ toolName, toolCallId: `${toolName}-${sessionId}`, input: { command: "test" } }, ctx);
      if (mutate) await writeFile(join(cwd, "tracked.txt"), "changed\n");
      for (const handler of app.handlers.get("tool_result") ?? [])
        await handler({ toolName, toolCallId: `${toolName}-${sessionId}`, input: { command: "test" }, content: [], details: {}, isError: false }, ctx);
      await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
      const result = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
      assert.match(result.content[0].text, mutate ? /Cannot complete until/ : /Work completed/);
      if (mutate) {
        await exec("git", ["checkout", "--", "tracked.txt"], { cwd });
      }
    }
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("blocked Guard calls stay read-only and Timeline restore messages invalidate Verify", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-integrations-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "integration-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Ship", todos: ["Finish"] }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "blocked-edit" }, ctx);
    app.emit("pi-guard:decision", { version: 1, cwd, decision: "blocked", toolCallId: "blocked-edit" });
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "blocked-edit", isError: true }, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    let result = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Work completed/);

    await tool.execute("plan-2", { action: "set_plan", goal: "Restore", todos: ["Finish"] }, undefined, undefined, ctx);
    await tool.execute("done-2", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    const contextHandler = app.handlers.get("context")![0];
    contextHandler({ messages: [{
      role: "custom", customType: "pi-worktree-mutation", content: "restored", details: {
        version: 1, cwd, changed: true, source: "pi-timeline", mutationId: "restore-1",
      },
    }] }, ctx);
    result = await tool.execute("complete-2", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Cannot complete until/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("execution completion requires a qualifying Verify result after mutation", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "verify-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("call", { action: "set_plan", goal: "Ship", todos: ["Implement"] }, undefined, undefined, ctx);
    const updated = await tool.execute("call", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    assert.equal(updated.terminate, undefined);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit" }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit" }, ctx);
    const blocked = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);
    assert.equal(blocked.terminate, undefined);
    app.emit("pi-verify:result", { version: 1, sessionId: ctx.sessionManager.getSessionId(), cwd, state: "passed", runId: "run", results: [] });
    const completed = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /Work completed.*No further continuity updates needed/);
    assert.equal(completed.terminate, true);
    const repeated = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(repeated.content[0].text, /already completed.*No further continuity updates needed/);
    assert.equal(repeated.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("subsequent plan inherits timeline lineage from a fresh executor session", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-lineage-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const previousRun = {
    version: 1,
    runId: "first-plan",
    timelineId: "first-plan",
    role: "executor",
    parentSessionId: "planner-session",
    createdAt: new Date().toISOString(),
  };
  const entries = [{
    type: "custom",
    customType: "pylon-run",
    data: previousRun,
  }];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    model: { provider: "provider", id: "executor" },
    sessionManager: {
      getSessionId: () => "fresh-executor-session",
      getEntries: () => entries,
    },
    isIdle: () => true,
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Plan another change", ctx);

    const nextRun = app.appended.find((entry) =>
      entry.customType === "pylon-run" && entry.data.role === "planner"
    )?.data;
    assert.ok(nextRun);
    assert.notEqual(nextRun.runId, previousRun.runId);
    assert.equal(nextRun.timelineId, previousRun.runId);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("explicit plan resets model context without replacing the visible session", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-handoff-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const models = new Map([
    ["provider/base", { provider: "provider", id: "base" }],
    ["provider/planner", { provider: "provider", id: "planner" }],
    ["provider/executor", { provider: "provider", id: "executor" }],
  ]);
  let newSessions = 0;
  let planningRun: Promise<void> | undefined;
  let app: ReturnType<typeof runtime>;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model: models.get("provider/base"),
    modelRegistry: {
      find: (provider: string, id: string) => models.get(`${provider}/${id}`),
      hasConfiguredAuth: () => true,
      getAvailable: () => [...models.values()],
    },
    sessionManager: {
      getSessionId: () => "planner-session",
      getSessionFile: () => join(root, "planner.jsonl"),
      getEntries: () => [],
    },
    isIdle: () => !planningRun,
    waitForIdle: async () => { await planningRun; },
    newSession: async () => { newSessions++; return { cancelled: false }; },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => "Approve — reset context",
      editor: async () => "",
    },
  };
  try {
    app = runtime();
    app.onSendUserMessage((message) => {
      if (!message.startsWith("Plan this task")) return;
      planningRun = (async () => {
        await Promise.resolve();
        for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
        await app.tools.get("continuity_update").execute(
          "call",
          {
            action: "set_plan",
            goal: "Ship change",
            planSummary: "Implement then verify",
            todos: ["Implement", "Verify"],
          },
          undefined,
          undefined,
          ctx,
        );
        for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
        planningRun = undefined;
      })();
    });
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("continuity").handler(
      "planner provider/planner:high",
      ctx,
    );
    await app.commands.get("continuity").handler(
      "executor provider/executor:low",
      ctx,
    );
    await app.commands.get("plan").handler("Ship change", ctx);
    await planningRun;
    await waitFor(() => app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"));
    assert.equal(newSessions, 0);
    assert.equal(app.selectedModel()?.id, "executor");
    assert.equal(app.thinking(), "low");
    assert.ok(!app.sent.some((message) => message.startsWith("/plan ")));
    const executorRun = [...app.appended].reverse().find((entry) =>
      entry.customType === "pylon-run" && entry.data.role === "executor"
    )?.data;
    assert.ok(executorRun);
    assert.equal(executorRun.timelineId, executorRun.runId);
    const boundary = app.customMessages[0]!;
    assert.equal(boundary.message.customType, "pi-continuity-handoff");
    assert.equal(boundary.message.details.timelineId, executorRun.timelineId);
    assert.equal(boundary.message.display, false);
    assert.equal(boundary.options.triggerTurn, false);
    assert.match(boundary.message.content, /Earlier messages remain visible but are excluded/);
    assert.match(boundary.message.content, /Plan: Implement then verify/);
    const kickoff = app.customMessages.find((entry) => entry.message.customType === "pi-continuity-execution");
    assert.ok(kickoff);
    assert.equal(kickoff.options.triggerTurn, true);
    assert.equal(kickoff.message.details.approvalToken, executorRun.approvalToken);
    assert.equal(kickoff.message.content, "Execute the approved Continuity plan now.");
    const context = app.handlers.get("context")![0];
    const filtered = await context({
      messages: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: [{ type: "text", text: "old response" }] },
        { role: "custom", ...boundary.message },
        { role: "custom", customType: "pi-continuity-memory", content: "stale memory", display: false },
        { role: "user", content: "executor prompt" },
      ],
    });
    assert.equal(filtered.messages.some((message: any) => message.content === "old prompt"), false);
    assert.equal(filtered.messages.some((message: any) => message.content === "stale memory"), false);
    assert.equal(filtered.messages.some((message: any) => message.content === "executor prompt"), true);
    assert.equal(filtered.messages[0].customType, "pi-continuity-handoff");

    for (const details of [
      undefined,
      { ...boundary.message.details, version: 2 },
      { ...boundary.message.details, runId: "other-run" },
      { ...boundary.message.details, timelineId: "other-timeline" },
    ]) {
      const unfiltered = await context({
        messages: [
          { role: "user", content: "keep old prompt" },
          { role: "custom", customType: "pi-continuity-handoff", details },
          { role: "user", content: "keep executor prompt" },
        ],
      });
      assert.equal(
        unfiltered.messages.some((message: any) => message.content === "keep old prompt"),
        true,
      );
    }

    await app.commands.get("plan").handler("cancel", ctx);
    const cancelledMessages = [
      { role: "user", content: "keep cancelled prompt" },
      { role: "custom", ...boundary.message },
    ];
    const cancelled = await context({ messages: cancelledMessages });
    assert.equal(
      (cancelled?.messages ?? cancelledMessages)
        .some((message: any) => message.content === "keep cancelled prompt"),
      true,
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("child reload preserves progress instead of replaying the handoff snapshot", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-child-reload-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const now = new Date().toISOString();
  const handoffWork = {
    schemaVersion: 1,
    mode: "executing",
    goal: "Ship change",
    approved: true,
    constraints: ["Keep compatibility"],
    planSummary: "Implement then verify",
    todos: [{ id: "todo_1", text: "Implement", status: "pending", updatedAt: now }],
    runId: "run-child",
    createdAt: now,
    updatedAt: now,
  };
  const model = { provider: "provider", id: "executor" };
  const entries = [{
    type: "custom",
    customType: "pi-continuity-handoff",
    data: { version: 1, work: handoffWork, model, thinking: "low" },
  }];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => "child-session",
      getEntries: () => entries,
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    const sessionStart = app.handlers.get("session_start")![0];
    await sessionStart({ reason: "startup" }, ctx);
    assert.equal(app.modelSelections(), 1);
    const leaseDirectory = join(root, "agent", "pi-continuity", "session-artifacts");
    const initialLeases = await readdir(leaseDirectory);
    assert.equal(initialLeases.length, 1);

    await app.tools.get("continuity_update").execute(
      "done",
      { action: "todo", todoId: "todo_1", status: "done" },
      undefined,
      undefined,
      ctx,
    );
    await sessionStart({ reason: "reload" }, ctx);

    assert.deepEqual(await readdir(leaseDirectory), initialLeases, "reload keeps the same lease continuously");
    assert.equal(app.modelSelections(), 1);
    const context = await app.handlers.get("context")![0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Done: 1/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("task widget resets after settlement but survives mid-turn steering", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-widget-reset-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const widgets: unknown[] = [];
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionId: () => "widget-reset-session", getEntries: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: (_name: string, value: unknown) => widgets.push(value),
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    const renderWidget = (widget: any) => widget({}, {
      fg: (_color: string, text: string) => text,
      strikethrough: (text: string) => `~${text}~`,
    }).render(1_000).map((line: string) => line.trimEnd());
    await tool.execute("call", {
      action: "set_plan",
      goal: "First task",
      todos: ["Implement", "Verify"],
    }, undefined, undefined, ctx);
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● Implement", "○ Verify"]);

    await tool.execute("call", {
      action: "todo",
      todoId: "todo_1",
      nextTodoId: "todo_2",
      status: "done",
    }, undefined, undefined, ctx);
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● ~Implement~", "● Verify"]);
    const shown = widgets.length;

    for (const handler of app.handlers.get("input") ?? [])
      await handler({ text: "Adjust it", source: "interactive", streamingBehavior: "steer" }, ctx);
    assert.equal(widgets.length, shown);

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    assert.equal(widgets.at(-1), undefined);

    await tool.execute("call", {
      action: "set_plan",
      goal: "Second task",
      todos: ["Verify"],
    }, undefined, undefined, ctx);
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● Verify"]);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("TUI approval waits for the scheduled planner response before showing choices", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-selector-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let selections = 0;
  let approvalTitle = "";
  let structuredPlan = "";
  let planningRun: Promise<void> | undefined;
  let app: ReturnType<typeof runtime>;
  const model = { provider: "provider", id: "base" };
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: {
      getSessionId: () => "selector-session",
      getEntries: () => [],
    },
    isIdle: () => !planningRun,
    waitForIdle: async () => { await planningRun; },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async (title: string) => {
        approvalTitle = title;
        selections++;
        return "Approve — continue current session";
      },
      editor: async () => "",
    },
  };
  try {
    app = runtime();
    app.onSendUserMessage((message) => {
      if (!message.startsWith("Plan this task")) return;
      planningRun = (async () => {
        await Promise.resolve();
        assert.equal(selections, 0);
        for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
        const result = await app.tools.get("continuity_update").execute(
          "call",
          {
            action: "set_plan",
            goal: "Ship change",
            planSummary: "Implement then verify",
            todos: ["Implement", "Verify"],
          },
          undefined,
          undefined,
          ctx,
        );
        structuredPlan = result.details.plan;
        for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
        planningRun = undefined;
      })();
    });
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await planningRun;
    await waitFor(() => app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"));
    assert.equal(selections, 1);
    assert.equal(approvalTitle, "Plan ready — review structured plan above");
    assert.match(structuredPlan, /^Plan\n\nGoal\nShip change/);
    assert.deepEqual(app.sent, [
      "Plan this task without modifying project files. Use continuity_update set_plan; put the approach in planSummary, concrete paths/symbols in workingSet, unresolved assumptions or gaps in assumptions, and completion checks in acceptanceCriteria. Keep todos outcome-level: Ship change",
    ]);
    const executorRun = [...app.appended].reverse().find((entry) =>
      entry.customType === "pylon-run" && entry.data.role === "executor"
    )?.data;
    assert.ok(executorRun?.runId);
    assert.ok(executorRun?.timelineId);
    assert.ok(!app.sent.some((message) => message.startsWith("/plan ")));
    assert.equal(app.customMessages.filter((entry) => entry.message.customType === "pi-continuity-execution").length, 1);
    const context = await app.handlers.get("context")?.[0]({
      messages: [{ role: "user", content: "Keep this context" }],
    }, ctx);
    assert.equal(context.messages[0].content, "Keep this context");
    assert.match(context.messages.at(-1).content, /Work: executing/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("dismissed TUI approval is offered again on the next settlement", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-dismissed-approval-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let selections = 0;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: {
      getSessionId: () => "dismissed-approval-session",
      getEntries: () => [],
    },
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => ++selections === 1
        ? undefined
        : "Approve — continue current session",
      editor: async () => "",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools.get("continuity_update").execute(
      "plan",
      {
        action: "set_plan",
        goal: "Ship change",
        planSummary: "Implement then verify",
        todos: ["Implement"],
      },
      undefined,
      undefined,
      ctx,
    );

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => selections === 1);
    for (let attempt = 0; attempt < 20 && selections < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    }
    assert.equal(selections, 2);
    await waitFor(() =>
      app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution")
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("unavailable executor leaves TUI approval pending", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-unavailable-executor-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let executorAvailable = false;
  let selections = 0;
  const notifications: string[] = [];
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        executorAvailable && provider === model.provider && id === model.id
          ? model
          : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: {
      getSessionId: () => "unavailable-executor-session",
      getEntries: () => [],
    },
    isIdle: () => true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      setWidget: () => {},
      select: async () => {
        selections++;
        return "Approve — continue current session";
      },
      editor: async () => "",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools.get("continuity_update").execute(
      "plan",
      {
        action: "set_plan",
        goal: "Ship change",
        planSummary: "Implement then verify",
        todos: ["Implement"],
      },
      undefined,
      undefined,
      ctx,
    );

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => notifications.includes("Executor model unavailable."));
    assert.equal(selections, 1);
    assert.ok(!app.active().includes("edit"));

    executorAvailable = true;
    for (let attempt = 0; attempt < 20 && selections < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    }
    assert.equal(selections, 2);
    await waitFor(() => app.active().includes("edit"));
    assert.ok(app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("approval survives a clarification turn and normalizes missing plan summary", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-replan-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let selections = 0;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: {
      getSessionId: () => "replan-session",
      getEntries: () => [],
    },
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => {
        selections++;
        return selections === 1
          ? "Request changes"
          : "Approve — continue current session";
      },
      editor: async () => "Keep the same steps but clarify wording",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);

    for (const handler of app.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);
    assert.equal(selections, 0);

    const rejected = await app.tools.get("continuity_update").execute(
      "empty",
      { action: "set_plan", goal: "Ship change", todos: [] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(rejected.content[0].text, /At least one non-empty todo/);

    await app.tools.get("continuity_update").execute(
      "final",
      { action: "set_plan", goal: "Ship change", todos: ["Implement", "Verify"] },
      undefined,
      undefined,
      ctx,
    );
    for (const handler of app.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);
    await waitFor(() => selections === 1);
    await waitFor(() => app.sent.some((message) => message.startsWith("Plan changes requested for revision 1:")));

    await app.tools.get("continuity_update").execute(
      "revised",
      { action: "set_plan", goal: "Ship change", todos: ["Implement", "Verify"] },
      undefined,
      undefined,
      ctx,
    );
    for (const handler of app.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);
    await waitFor(() =>
      app.active().includes("edit") &&
      app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"),
    );

    assert.equal(selections, 2);
    assert.ok(app.active().includes("edit"));
    assert.ok(app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"));
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Plan anchor: Implement; Verify/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("RPC settlement presents plan review and keeps Plan mode status until approval", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-rpc-plan-review-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  const statuses: Array<string | undefined> = [];
  let selections = 0;
  let editors = 0;
  const selectOptions: unknown[] = [];
  const editorOptions: unknown[] = [];
  const ctx: any = {
    cwd, hasUI: true, mode: "rpc", model, isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "rpc-plan-review-session", getEntries: () => [] },
    ui: {
      notify: () => {},
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      setWidget: () => {},
      select: async (_title: string, _choices: string[], options: unknown) => {
        selectOptions.push(options);
        return ++selections === 1 ? "Request changes" : "Approve — reset context";
      },
      editor: async (_title: string, _prefill: string, options: unknown) => {
        editorOptions.push(options);
        editors++;
        return "Clarify the implementation boundary.";
      },
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools.get("continuity_update").execute("plan", {
      action: "set_plan", goal: "Ship change", planSummary: "Implement", todos: ["Implement"],
    }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => app.sent.some((message) => message.startsWith("Plan changes requested for revision 1:")));
    assert.equal(selections, 1);
    assert.equal(editors, 1);
    assert.deepEqual(selectOptions, [{ timeout: 0 }]);
    assert.deepEqual(editorOptions, [{ timeout: 0 }]);
    assert.equal(statuses.at(-1), "Plan mode");

    await app.tools.get("continuity_update").execute("revised", {
      action: "set_plan", goal: "Ship change", planSummary: "Implement safely", todos: ["Implement"],
    }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"));

    assert.equal(selections, 2);
    assert.deepEqual(selectOptions, [{ timeout: 0 }, { timeout: 0 }]);
    assert.equal(statuses.at(-1), undefined);
    const kickoff = app.customMessages.find((entry) => entry.message.customType === "pi-continuity-execution");
    assert.equal(kickoff?.message.content, "Execute the approved Continuity plan now.");
    assert.ok(app.customMessages.some((entry) => entry.message.customType === "pi-continuity-handoff"));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Inspector feedback makes an open RPC approval dialog stale without requeueing it", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-rpc-plan-race-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let resolveChoice: ((choice: string | undefined) => void) | undefined;
  let selections = 0;
  const ctx: any = {
    cwd, hasUI: true, mode: "rpc", model, isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "rpc-plan-race-session", getEntries: () => [] },
    ui: {
      notify: () => {}, setStatus: () => {}, setWidget: () => {},
      select: async () => { selections++; return new Promise<string | undefined>((resolve) => { resolveChoice = resolve; }); },
      editor: async () => "",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools.get("continuity_update").execute("plan", {
      action: "set_plan", goal: "Ship change", planSummary: "Implement", todos: ["Implement"],
    }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => selections === 1 && Boolean(resolveChoice));

    let action: Promise<unknown> | undefined;
    app.emit("pi-continuity:plan-action", {
      version: 1,
      sessionId: "rpc-plan-race-session",
      expectedGeneration: 1,
      expectedRevision: 1,
      action: "requestChanges",
      feedback: "Use the narrower boundary.",
      respond: (value: unknown | Promise<unknown>) => { action = Promise.resolve(value); },
    });
    await action;
    resolveChoice!("Approve — continue current session");
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(selections, 1);
    assert.equal(app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"), false);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("RPC plan actions persist feedback, preserve todo IDs, and approve the reviewed revision", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-plan-action-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  const ctx: any = {
    cwd, hasUI: false, mode: "rpc", model, isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "rpc-plan-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools.get("continuity_update").execute("plan", {
      action: "set_plan",
      goal: "Ship change",
      planSummary: "Update the boundary",
      workingSet: ["src/index.ts"],
      assumptions: ["The API remains stable."],
      acceptanceCriteria: ["Focused tests pass."],
      todos: ["Implement", "Review"],
    }, undefined, undefined, ctx);

    const state = () => {
      let snapshot: any;
      app.emit("pi-continuity:state-request", { version: 4, sessionId: "rpc-plan-session", respond: (value: any) => { snapshot = value; } });
      return snapshot;
    };
    const action = (request: Record<string, unknown>) => {
      let result: Promise<unknown> | undefined;
      app.emit("pi-continuity:plan-action", {
        version: 1,
        sessionId: "rpc-plan-session",
        expectedGeneration: 1,
        ...request,
        respond: (value: unknown | Promise<unknown>) => { result = Promise.resolve(value); },
      });
      assert.ok(result);
      return result;
    };
    const initial = state().work;
    assert.deepEqual(initial.handoff.workingSet, ["src/index.ts"]);
    await action({ action: "requestChanges", expectedRevision: 1, feedback: "Clarify the implementation step." });
    assert.equal(state().work.revisionFeedback.text, "Clarify the implementation step.");
    await assert.rejects(action({ action: "approve", resetContext: false, expectedRevision: 1 }), /requested changes/i);
    await assert.rejects(action({ action: "approve", resetContext: false, expectedRevision: 2 }), /revision changed/i);

    await app.tools.get("continuity_update").execute("revised", {
      action: "set_plan",
      goal: "Ship change",
      planSummary: "Update the boundary safely",
      planTodos: [
        { id: initial.todos[0].id, text: "Implement safely" },
        { id: initial.todos[1].id, text: "Review" },
      ],
    }, undefined, undefined, ctx);
    const revised = state().work;
    assert.equal(revised.planRevision, 2);
    assert.equal(revised.todos[0].id, initial.todos[0].id);
    assert.equal(revised.revisionFeedback, undefined);

    await Promise.all([
      action({ action: "approve", resetContext: false, expectedRevision: 2 }),
      action({ action: "approve", resetContext: false, expectedRevision: 2 }),
    ]);
    assert.equal(app.customMessages.filter((entry) => entry.message.customType === "pi-continuity-execution").length, 1);
    assert.equal(app.appended.filter((entry) => entry.customType === "pylon-run" && entry.data.role === "executor").length, 1);
    assert.equal(state().work.approvalPending, true);
    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    assert.equal(state().work.approvalPending, false);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted approval reconciles forward once on reload", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-approval-recovery-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let app: ReturnType<typeof runtime>;
  const ctx: any = {
    cwd, hasUI: true, mode: "tui", model, isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => "approval-recovery-session",
      getEntries: () => [
        ...(app?.appended ?? []).map((entry) => ({ type: "custom", ...entry })),
        ...(app?.customMessages ?? []).map((entry) => ({ type: "custom_message", ...entry.message })),
      ],
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, select: async () => undefined },
  };
  try {
    app = runtime();
    const sessionStart = app.handlers.get("session_start")![0];
    await sessionStart({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools.get("continuity_update").execute("plan", {
      action: "set_plan", goal: "Ship change", planSummary: "Implement", todos: ["Implement"],
    }, undefined, undefined, ctx);

    app.failNextAppend();
    await assert.rejects(app.commands.get("plan").handler("approve-current", ctx), /append failed/);
    assert.equal(app.appended.filter((entry) => entry.customType === "pylon-run" && entry.data.role === "executor").length, 0);

    await sessionStart({ reason: "reload" }, ctx);
    await waitFor(() => app.customMessages.some((entry) => entry.message.customType === "pi-continuity-execution"));
    const token = app.appended.find((entry) => entry.customType === "pylon-run" && entry.data.role === "executor")?.data.approvalToken;
    assert.ok(token);
    assert.equal(app.appended.filter((entry) => entry.data?.approvalToken === token).length, 1);
    assert.equal(app.customMessages.filter((entry) => entry.message.details?.approvalToken === token).length, 1);

    await sessionStart({ reason: "reload" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.appended.filter((entry) => entry.data?.approvalToken === token).length, 1);
    assert.equal(app.customMessages.filter((entry) => entry.message.details?.approvalToken === token).length, 1);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("plan mode permits memory list but blocks memory mutations", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-memory-plan-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json", isIdle: () => true,
    sessionManager: { getSessionId: () => "memory-plan-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Inspect memory", ctx);
    assert.ok(app.active().includes("memory"));
    const guard = app.handlers.get("tool_call")![0];
    assert.equal(await guard({ toolName: "memory", input: { action: "list" } }, ctx), undefined);
    assert.match((await guard({ toolName: "memory", input: { action: "add" } }, ctx)).reason, /Memory mutations are blocked.*list only/i);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("duplicate continuity instance does not register stale planning handlers", () => {
  const app = runtime();
  const starts = app.handlers.get("agent_start")?.length;
  const calls = app.handlers.get("tool_call")?.length;
  app.loadAgain();
  assert.equal(app.handlers.get("agent_start")?.length, starts);
  assert.equal(app.handlers.get("tool_call")?.length, calls);
});

test("session startup safely reassociates a moved repository and retains a backup", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-v6-owner-startup-")), oldPath = join(root, "old"), cwd = join(root, "moved");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(oldPath); await exec("git", ["init", "-q"], { cwd: oldPath }); await exec("git", ["config", "user.email", "test@example.com"], { cwd: oldPath }); await exec("git", ["config", "user.name", "Test"], { cwd: oldPath });
    await writeFile(join(oldPath, "one.txt"), "one\n"); await exec("git", ["add", "."], { cwd: oldPath }); await exec("git", ["commit", "-m", "one"], { cwd: oldPath }); const first = String((await exec("git", ["rev-parse", "HEAD"], { cwd: oldPath })).stdout).trim();
    await writeFile(join(oldPath, "two.txt"), "two\n"); await exec("git", ["add", "."], { cwd: oldPath }); await exec("git", ["commit", "-m", "two"], { cwd: oldPath }); const second = String((await exec("git", ["rev-parse", "HEAD"], { cwd: oldPath })).stdout).trim();
    const oldOwner = (await projectContext(oldPath, "fallback")).owner, id = serverNoteId(), continuityRoot = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity"), statePath = join(continuityRoot, "memory-v6", "state.json");
    await writeJsonAtomic(join(continuityRoot, "workspaces.json"), [{ id: "old-workspace", canonicalPath: oldPath, projectOwner: oldOwner, createdAt: "2020-01-01T00:00:00Z", lastSeenAt: "2020-01-01T00:00:00Z" }]);
    await writeJsonAtomic(statePath, { ...emptyMemoryState(), revision: 1, updatedAt: new Date().toISOString(), notes: [{ id, scope: "project", owner: oldOwner, trigger: "changing the boundary", guidance: "Preserve it.", authority: "project_contract", origin: "agent", sourceRefs: [{ type: "repository", path: "one.txt", excerptSha256: "a".repeat(64), captureCommit: first }, { type: "repository", path: "two.txt", excerptSha256: "b".repeat(64), captureCommit: second }], disposition: "archival", enforcementAuthority: "context_only", revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] });
    await rename(oldPath, cwd);
    const ctx: any = { cwd, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "owner-move-session", getEntries: () => [] }, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} } };
    const app = runtime(); for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const currentOwner = (await projectContext(cwd, "fallback")).owner, state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.notes[0]?.owner, currentOwner); assert.equal(state.notes[0]?.revision, 2); assert.equal(state.audits?.at(-1)?.type, "owner_reassociation"); assert.equal(isMemoryState(state), true);
    const backups = await readdir(join(continuityRoot, "memory-v6", "backups")); assert.ok(backups.some((name) => name.startsWith("owner-reassociation-")));
  } finally { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; await rm(root, { recursive: true, force: true }); }
});

test("explicit V4 migration command requires UI confirmation and a reviewer", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-v6-migrate-command-")), cwd = join(root, "repo");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(cwd); await exec("git", ["init", "-q"], { cwd });
    const continuityRoot = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity");
    await writeJsonAtomic(join(continuityRoot, "memory-v4", "memory.json"), { schemaVersion: 4, facts: [] });
    await writeJsonAtomic(join(continuityRoot, "memory-v4", "candidates.json"), { schemaVersion: 4, candidates: [] });
    const notices: string[] = []; let confirmed = false;
    const ctx: any = { cwd, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "migrate-command-session", getEntries: () => [] }, modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false }, ui: { notify: (message: string) => notices.push(message), setStatus: () => {}, setWidget: () => {}, confirm: async () => confirmed } };
    const app = runtime(); for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    let snapshot: any; app.emit("pi-continuity:state-request", { version: 4, sessionId: "migrate-command-session", respond: (value: unknown) => { snapshot = value; } });
    assert.equal(snapshot.v4MigrationAvailable, true);
    let response: Promise<unknown> | undefined;
    app.emit("pi-continuity:memory-mutation", { version: 2, sessionId: "migrate-command-session", expectedGeneration: 1, action: "migrate", respond: (value: unknown) => { response = Promise.resolve(value); } });
    await assert.rejects(response!, /Memory Reviewer is not configured/);
    app.emit("pi-continuity:memory-mutation", { version: 2, sessionId: "migrate-command-session", expectedGeneration: 1, action: "migrate", scope: "user", respond: (value: unknown) => { response = Promise.resolve(value); } });
    await assert.rejects(response!, /invalid memory migration fields/);
    const command = app.commands.get("memory").handler;
    await command("migrate-v4", ctx); assert.match(notices.at(-1) ?? "", /Interactive UI required/);
    ctx.hasUI = true; await command("migrate-v4", ctx); assert.doesNotMatch(notices.at(-1) ?? "", /migration failed/i);
    confirmed = true; await command("migrate-v4", ctx); assert.match(notices.at(-1) ?? "", /Memory Reviewer is not configured/);
    assert.equal(JSON.parse(await readFile(join(continuityRoot, "memory-v6", "migration.json"), "utf8")).status, "pending");
  } finally { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; await rm(root, { recursive: true, force: true }); }
});

test("interactive memory edit, forget, project purge, and rollback persist V6 state and audit", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-v6-memory-commands-")), cwd = join(root, "repo");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const userId = "00000000-0000-4000-8000-000000000001", projectId = "00000000-0000-4000-8000-000000000002", foreignId = "00000000-0000-4000-8000-000000000003";
  try {
    await mkdir(cwd); await exec("git", ["init", "-q"], { cwd });
    const owner = (await projectContext(cwd, "fallback")).owner;
    const statePath = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "state.json");
    const note = (id: string, scope: "user" | "project", noteOwner: string) => ({
      id, scope, owner: noteOwner, trigger: "replying to a request", guidance: "Keep replies concise.", authority: scope === "user" ? "user_instruction" : "project_contract", origin: "user",
      sourceRefs: [{ type: "direct_user_edit" as const }], disposition: "archival" as const, enforcementAuthority: "context_only" as const, revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
    await writeJsonAtomic(statePath, { ...emptyMemoryState(), revision: 1, updatedAt: new Date().toISOString(), notes: [note(userId, "user", "default"), note(projectId, "project", owner), note(foreignId, "project", "other-owner")] });
    const notices: string[] = [], confirmations: string[] = []; let editorCalls = 0;
    const ctx: any = {
      cwd, hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "memory-command-session", getEntries: () => [] },
      ui: { notify: (message: string) => notices.push(message), setStatus: () => {}, setWidget: () => {}, confirm: async (title: string) => { confirmations.push(title); return true; }, editor: async () => {
        editorCalls++;
        if (editorCalls === 2) { const current = JSON.parse(await readFile(statePath, "utf8")); current.revision++; current.notes = current.notes.map((item: any) => item.id === userId ? { ...item, revision: item.revision + 1 } : item); await writeJsonAtomic(statePath, current); }
        return "Trigger:\nreplying to a request\n\nGuidance:\nUse compact answers.";
      } },
    };
    const app = runtime(); for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const command = app.commands.get("memory").handler;
    await command(`edit user ${userId}`, ctx);
    let state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.notes.find((item: any) => item.id === userId)?.guidance, "Use compact answers."); assert.equal(state.notes.find((item: any) => item.id === userId)?.revision, 2); assert.equal(state.audits?.at(-1)?.type, "direct_edit");
    await command(`edit user ${userId}`, ctx);
    state = JSON.parse(await readFile(statePath, "utf8")); assert.equal(state.notes.find((item: any) => item.id === userId)?.revision, 3); assert.ok(notices.some((message) => /changed/i.test(message)));
    await command(`forget user ${userId}`, ctx); await command("forget project", ctx);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.notes.some((item: any) => item.id === userId), false); assert.equal(state.notes.some((item: any) => item.id === projectId), false); assert.equal(state.notes.some((item: any) => item.id === foreignId), true);
    const backupPath = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "backups", "pre-migration.json");
    await writeJsonAtomic(backupPath, emptyMemoryState());
    await writeJsonAtomic(join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "migration.json"), { version: 1, sourceHashes: {}, status: "activated", completedRecordIds: [], reviewerBatchIds: [], activatedStateRevision: state.revision, preMigrationBackup: backupPath, retryCount: 0, diagnostics: [] });
    await command("rollback", ctx);
    state = JSON.parse(await readFile(statePath, "utf8")); assert.equal(isMemoryState(state), true); assert.deepEqual(state.notes, []);
    const journal = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "migration.json"), "utf8")); assert.equal(journal.status, "rolled_back");
    assert.deepEqual(confirmations, ["Save user memory?", "Save user memory?", "Forget user memory?", "Forget all project memory?", "Rollback Memory V6 migration?"]);
  } finally { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; await rm(root, { recursive: true, force: true }); }
});

test("review settlement rechecks provenance and rejects stale generations", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR, root = await mkdtemp(join(tmpdir(), "continuity-v6-settlement-")), cwd = join(root, "repo");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(cwd); await exec("git", ["init"], { cwd }); await exec("git", ["config", "user.email", "test@example.com"], { cwd }); await exec("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "file.txt"), "one\n"); await exec("git", ["add", "."], { cwd }); await exec("git", ["commit", "-m", "initial"], { cwd }); await writeFile(join(cwd, "file.txt"), "two\n");
    const branch: any[] = [{ id: "tool-result", type: "message", message: { role: "toolResult", toolCallId: "memory-call", content: [] } }];
    const app = runtime(["memory", "continuity_update"]), ctx: any = {
      cwd, hasUI: false, mode: "json", modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
      sessionManager: { getSessionId: () => "settlement-session", getSessionFile: () => "session.jsonl", getEntries: () => [], getBranch: () => branch, buildContextEntries: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const owner = (await projectContext(cwd, "fallback")).owner, created = serverNoteId(), activationDraft = archivalActivationDraft();
    const review: ReviewRecord = { reviewId: serverReviewId(), sessionId: "settlement-session", toolCallId: "memory-call", projectOwner: owner, reviewedAt: new Date().toISOString(), status: "approved_pending", verificationStatus: { status: "verified", verifiedAt: new Date().toISOString(), sourceSnapshotId: "a".repeat(64) }, generation: 1, taskGeneration: 1, operations: [{ operation: "add", noteId: created, scope: "project", owner, trigger: "changing the boundary", guidance: "Preserve the documented boundary.", authority: "project_contract", sourceRefs: [], disposition: "archival", enforcementAuthority: "context_only", activationDraft, rawProposal: { trigger: "changing the boundary", guidance: "Preserve the documented boundary." }, rewriteCharacter: "format_only" }], rejectionCounts: {} };
    const statePath = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "state.json");
    const pendingState = { ...emptyMemoryState(), revision: 1, reviews: [review], updatedAt: new Date().toISOString() };
    assert.equal(isMemoryState(pendingState), true);
    await writeJsonAtomic(statePath, pendingState);
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    const stateEntries = await readdir(join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6"));
    assert.ok(stateEntries.includes("state.json"), `state entries: ${stateEntries.join(", ")}`);
    const committed = JSON.parse(await readFile(statePath, "utf8")); assert.equal(committed.notes[0]?.id, created); assert.equal(committed.reviews[0]?.status, "committed");
    const stale = { ...review, reviewId: serverReviewId(), toolCallId: "stale-call", generation: 0, status: "approved_pending" as const, operations: [] };
    branch.push({ id: "stale-result", type: "message", message: { role: "toolResult", toolCallId: "stale-call", content: [] } });
    const staleState = { ...committed, reviews: [...committed.reviews, stale] };
    assert.equal(isReviewRecord(stale), true, JSON.stringify(stale));
    assert.equal(committed.reviews.every(isReviewRecord), true, JSON.stringify(committed.reviews));
    assert.equal(committed.notes.every(isNotebookNote), true, JSON.stringify(committed.notes));
    assert.equal(isMemoryState(staleState), true, JSON.stringify(staleState));
    await writeJsonAtomic(statePath, staleState);
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    const discarded = JSON.parse(await readFile(statePath, "utf8")); assert.equal(discarded.reviews.find((item: any) => item.reviewId === stale.reviewId)?.status, "discarded");
    let response: Promise<unknown> | undefined;
    app.emit("pi-continuity:memory-mutation", { version: 2, sessionId: "settlement-session", expectedGeneration: 1, action: "update", scope: "project", id: created, trigger: "changing the boundary", guidance: "Preserve the reviewed boundary.", expectedRevision: 1, respond: (value: unknown) => { response = Promise.resolve(value); } });
    await response; const edited = JSON.parse(await readFile(statePath, "utf8")); assert.equal(edited.notes[0]?.revision, 2); assert.equal(edited.notes[0]?.origin, "user");
    app.emit("pi-continuity:memory-mutation", { version: 2, sessionId: "settlement-session", expectedGeneration: 0, action: "delete", scope: "project", id: created, expectedRevision: 2, respond: (value: unknown) => { response = Promise.resolve(value); } });
    await assert.rejects(response!, /stale/);
    app.emit("pi-continuity:memory-mutation", { version: 2, sessionId: "settlement-session", expectedGeneration: 1, action: "delete", scope: "project", owner: "forged", id: created, expectedRevision: 2, respond: (value: unknown) => { response = Promise.resolve(value); } });
    await assert.rejects(response!, /fields/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
