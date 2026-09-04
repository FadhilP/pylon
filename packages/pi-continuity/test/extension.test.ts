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
import {
  archivalActivationDraft,
  emptyMemoryState,
  isMemoryState,
  isNotebookNote,
  isReviewRecord,
  serverNoteId,
  serverReviewId,
  sha256,
  type NotebookNote,
  type ReviewRecord,
} from "../src/memory.ts";
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
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "timed out waiting for asynchronous extension action");
}

const generatedWriteDraft = (): ActivationDraft => ({
  classification: "grounded",
  subscriptions: ["before_tool_call"],
  predicate: {
    all: [
      { fact: "tool.name", op: "eq", value: "edit" },
      { fact: "file.path", op: "matchesGlob", value: "src/generated/**" },
    ],
  },
  delivery: "warn",
  lifecycle: { activateUntil: "task_complete", rearmOn: ["context_compacted"] },
  examples: {
    positive: [{ event: "before_tool_call", facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" } }],
    hardNegative: [{ event: "before_tool_call", facts: { "tool.name": "edit", "file.path": "src/source/client.ts" } }],
  },
});
const formatCommandDraft = (): ActivationDraft => ({
  classification: "grounded",
  subscriptions: ["before_tool_call", "after_tool_result"],
  predicate: {
    all: [
      { fact: "tool.name", op: "eq", value: "bash" },
      { fact: "tool.command", op: "startsWith", value: "dart format" },
    ],
  },
  delivery: "warn",
  lifecycle: { activateUntil: "event_complete", rearmOn: [] },
  examples: {
    positive: [{ event: "before_tool_call", facts: { "tool.name": "bash", "tool.command": "dart format lib" } }],
    hardNegative: [{ event: "before_tool_call", facts: { "tool.name": "bash", "tool.command": "echo dart format" } }],
  },
});
const activatedNote = (overrides: Partial<NotebookNote> = {}): NotebookNote => ({
  id: serverNoteId(),
  scope: "user",
  owner: "default",
  trigger: "editing generated files",
  guidance: "Edit the generator instead.",
  authority: "user_instruction",
  origin: "agent",
  sourceRefs: [{ type: "direct_user_edit" }],
  disposition: "eligible_advisory",
  enforcementAuthority: "warning",
  activationDraft: generatedWriteDraft(),
  rawProposal: { trigger: "editing generated files", guidance: "Edit the generator instead." },
  rewriteCharacter: "format_only",
  revision: 1,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
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
  const emitted: Array<{ channel: string; value: any }> = [];
  let sendHook: ((message: string) => void) | undefined;
  let appendFailure: Error | undefined;
  let sendFailure: Error | undefined;
  const pi: any = {
    events: {
      emit: (channel: string, value: unknown) => {
        emitted.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
      on: (channel: string, listener: (value: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
    },
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => {
      active = [...next];
    },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: any) => {
      if (appendFailure) {
        const error = appendFailure;
        appendFailure = undefined;
        throw error;
      }
      appended.push({ customType, data });
    },
    setModel: async (model: any) => {
      selectedModel = model;
      modelSelections++;
      return true;
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (next: string) => {
      thinking = next;
    },
    sendUserMessage: (message: string) => {
      sent.push(message);
      sendHook?.(message);
    },
    sendMessage: (message: any, options: any) => {
      if (sendFailure) {
        const error = sendFailure;
        sendFailure = undefined;
        throw error;
      }
      customMessages.push({ message, options });
    },
  };
  extension(pi);
  return {
    handlers,
    tools,
    commands,
    appended,
    customMessages,
    sent,
    emitted,
    selectedModel: () => selectedModel,
    modelSelections: () => modelSelections,
    thinking: () => thinking,
    active: () => [...active],
    loadAgain: () => extension(pi),
    onSendUserMessage: (hook: (message: string) => void) => {
      sendHook = hook;
    },
    failNextAppend: (error = new Error("append failed")) => {
      appendFailure = error;
    },
    failNextSend: (error = new Error("send failed")) => {
      sendFailure = error;
    },
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
      cwd,
      hasUI: false,
      mode: "json",
      sessionManager: {
        getSessionId: () => "memory-disabled",
        getSessionFile: () => undefined,
        getEntries: () => [],
        getBranch: () => [],
        buildContextEntries: () => [],
      },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    assert.equal(app.active().includes("memory"), false);
    assert.equal(app.active().includes("continuity_recall"), true);
    assert.equal(app.active().includes("continuity_update"), true);
    const policy = app.emitted
      .filter(event => event.channel === "pylon:tool-policy" && event.value?.kind === "register")
      .at(-1)?.value;
    assert.deepEqual(policy.deferredTools, ["continuity_recall"]);
    assert.equal(policy.toolUsage.memory, undefined);
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

test("memory is deferred only until a Memory Reviewer is configured", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    for (const reviewerConfigured of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), `continuity-memory-exposure-${reviewerConfigured}-`));
      process.env.PI_CODING_AGENT_DIR = join(root, "agent");
      try {
        await mkdir(join(root, "repo"));
        await saveConfig({
          version: 2,
          memoryEnabled: true,
          ...(reviewerConfigured ? { memoryReviewer: { model: "openai/reviewer" } } : {}),
        });
        const app = runtime(["read", "continuity_update"]);
        const ctx: any = {
          cwd: join(root, "repo"),
          hasUI: false,
          mode: "json",
          sessionManager: {
            getSessionId: () => `memory-exposure-${reviewerConfigured}`,
            getSessionFile: () => undefined,
            getEntries: () => [],
            getBranch: () => [],
            buildContextEntries: () => [],
          },
          ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
        };
        for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
        const policy = app.emitted
          .filter(event => event.channel === "pylon:tool-policy" && event.value?.kind === "register")
          .at(-1)?.value;
        assert.deepEqual(
          policy.deferredTools,
          reviewerConfigured ? ["continuity_recall"] : ["continuity_recall", "memory"],
        );
        for (const handler of app.handlers.get("session_shutdown") ?? []) await handler();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("V5 notes migrate losslessly to archival V6 without prompt-similarity activation", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-v5-migration-"));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent"),
    now = new Date().toISOString();
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    const v5Path = join(agentDir, "pi-continuity", "memory-v5", "state.json");
    await writeJsonAtomic(v5Path, {
      schemaVersion: 5,
      revision: 1,
      reviews: [],
      updatedAt: now,
      notes: [
        {
          id: serverNoteId(),
          scope: "user",
          owner: "default",
          trigger: "package configuration changes",
          guidance: "Restart runtime services.",
          authority: "user_instruction",
          origin: "user",
          sourceRefs: [{ type: "direct_user_edit" }],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const rawV5 = await readFile(v5Path, "utf8");
    const app = runtime(),
      ctx: any = {
        cwd,
        hasUI: true,
        mode: "json",
        sessionManager: {
          getSessionId: () => "memory-migration",
          getSessionFile: () => undefined,
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
        },
        ui: { notify: () => {}, confirm: async () => true, setStatus: () => {}, setWidget: () => {} },
      };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const migrated = JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "state.json"), "utf8"));
    assert.equal(migrated.schemaVersion, 6);
    assert.equal(migrated.notes[0].guidance, "Restart runtime services.");
    assert.equal(migrated.notes[0].disposition, "archival");
    assert.equal(
      JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "migration-v5.json"), "utf8")).status,
      "activated",
    );
    assert.equal(
      await app.handlers.get("before_agent_start")![0]({ prompt: "package configuration runtime" }, ctx),
      undefined,
    );
    const oldMemory = {
      role: "custom",
      customType: "pi-continuity-memory",
      content: "legacy lexical injection",
      details: { version: 1 },
    };
    const result = await app.handlers.get("context")![0](
      { messages: [oldMemory, { role: "user", content: "request" }] },
      ctx,
    );
    assert.deepEqual(
      result.messages.filter((message: any) => message.customType === "pi-continuity-memory"),
      [],
    );
    await app.commands.get("memory").handler("rollback", ctx);
    assert.deepEqual(
      JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "state.json"), "utf8")).notes,
      [],
    );
    assert.equal(
      JSON.parse(await readFile(join(agentDir, "pi-continuity", "memory-v6", "migration-v5.json"), "utf8")).status,
      "rolled_back",
    );
    assert.equal(await readFile(v5Path, "utf8"), rawV5);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("grounded rules activate from typed tool events without interrupting the action", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-event-"));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent"),
    memory = activatedNote();
  const commandMemory = activatedNote({
    id: serverNoteId(),
    trigger: "running Dart formatting",
    guidance: "Do not run Dart format.",
    activationDraft: formatCommandDraft(),
    rawProposal: { trigger: "running Dart formatting", guidance: "Do not run Dart format." },
  });
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    await writeJsonAtomic(join(agentDir, "pi-continuity", "memory-v6", "state.json"), {
      ...emptyMemoryState(),
      revision: 1,
      notes: [memory, commandMemory],
      updatedAt: new Date().toISOString(),
    });
    const app = runtime(["read", "edit", "continuity_update"]),
      ctx: any = {
        cwd,
        hasUI: false,
        mode: "json",
        sessionManager: {
          getSessionId: () => "memory-event",
          getSessionFile: () => undefined,
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
        },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const toolCall = app.handlers.get("tool_call")![0];
    assert.equal(
      await toolCall({ toolName: "edit", toolCallId: "source", input: { path: "src/source/client.ts" } }, ctx),
      undefined,
    );
    assert.equal(app.customMessages.length, 0, "hard negative produces no intervention");
    assert.equal(
      await toolCall({ toolName: "edit", toolCallId: "generated", input: { path: "src/generated/client.ts" } }, ctx),
      undefined,
    );
    assert.equal(app.customMessages.length, 1);
    assert.match(app.customMessages[0]!.message.content, /Edit the generator instead/);
    assert.equal(app.customMessages[0]!.options.deliverAs, "steer");
    assert.equal(
      await toolCall(
        { toolName: "edit", toolCallId: "generated-sibling", input: { path: "src/generated/other.ts" } },
        ctx,
      ),
      undefined,
    );
    assert.equal(
      app.customMessages.length,
      1,
      "a visible event-complete memory is not queued again for a sibling tool call",
    );
    assert.equal(
      await toolCall({ toolName: "read", toolCallId: "sibling", input: { path: "README.md" } }, ctx),
      undefined,
      "unrelated siblings are never blocked",
    );
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    assert.equal(
      await toolCall(
        { toolName: "bash", toolCallId: "format", input: { command: `dart format lib --token=${credential}` } },
        ctx,
      ),
      undefined,
    );
    assert.equal(app.customMessages.length, 2);
    assert.match(app.customMessages[1]!.message.content, /Do not run Dart format/);
    await app.handlers.get("tool_result")![0](
      {
        toolName: "bash",
        toolCallId: "format",
        input: { command: `dart format lib --token=${credential}` },
        content: [],
        details: { exitCode: 0 },
        isError: false,
      },
      ctx,
    );
    assert.equal(app.customMessages.length, 2, "before/result hooks deduplicate by causal tool call");
    assert.doesNotMatch(
      JSON.stringify({ appended: app.appended, messages: app.customMessages }),
      new RegExp(credential),
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("changed project evidence suppresses new activation and active reinjection", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-freshness-"));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent"),
    excerpt = "Generated files must be edited through the generator.";
  await mkdir(cwd);
  await exec("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "README.md"), `${excerpt}\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    const owner = (await projectContext(cwd, "fallback")).owner,
      reviewId = serverReviewId(),
      excerptSha256 = sha256(excerpt);
    const memory = activatedNote({
      scope: "project",
      owner,
      authority: "project_contract",
      sourceRefs: [{ type: "repository", path: "README.md", excerptSha256 }],
      sourceReviewId: reviewId,
    });
    const operation = {
      operation: "add" as const,
      noteId: memory.id,
      scope: memory.scope,
      owner,
      trigger: memory.trigger,
      guidance: memory.guidance,
      authority: "project_contract" as const,
      sourceRefs: memory.sourceRefs,
      disposition: memory.disposition,
      enforcementAuthority: memory.enforcementAuthority,
      activationDraft: memory.activationDraft!,
      rawProposal: memory.rawProposal!,
      rewriteCharacter: memory.rewriteCharacter!,
    };
    const review: ReviewRecord = {
      reviewId,
      sessionId: "source",
      toolCallId: "source",
      projectOwner: owner,
      reviewedAt: memory.createdAt,
      status: "committed",
      verificationStatus: { status: "verified", verifiedAt: memory.createdAt, sourceSnapshotId: sha256(excerptSha256) },
      operations: [operation],
      rejectionCounts: {},
      generation: 1,
      taskGeneration: 1,
      evidenceBatches: [[{ path: "README.md", start: 1, end: 1, excerptSha256 }]],
      settledAt: memory.createdAt,
    };
    assert.equal(isReviewRecord(review), true);
    await writeJsonAtomic(join(agentDir, "pi-continuity", "memory-v6", "state.json"), {
      ...emptyMemoryState(),
      revision: 1,
      notes: [memory],
      reviews: [review],
      updatedAt: new Date().toISOString(),
    });
    const app = runtime(["edit", "continuity_update"]),
      ctx: any = {
        cwd,
        hasUI: false,
        mode: "json",
        sessionManager: {
          getSessionId: () => "memory-freshness",
          getSessionFile: () => undefined,
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
        },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const toolCall = app.handlers.get("tool_call")![0],
      toolResult = app.handlers.get("tool_result")![0];
    await toolCall({ toolName: "edit", toolCallId: "first", input: { path: "src/generated/client.ts" } }, ctx);
    assert.equal(app.customMessages.length, 1);
    await writeFile(join(cwd, "README.md"), "Contract changed.\n");
    await toolResult(
      {
        toolName: "edit",
        toolCallId: "contract-change",
        input: { path: "README.md" },
        content: [],
        details: {},
        isError: false,
      },
      ctx,
    );
    for (const handler of app.handlers.get("session_compact") ?? []) await handler({}, ctx);
    assert.equal(app.customMessages.length, 1, "stale active rule is not reinjected");
    for (const handler of app.handlers.get("input") ?? []) handler({ source: "interactive", text: "new task" });
    await toolCall({ toolName: "edit", toolCallId: "after-change", input: { path: "src/generated/new.ts" } }, ctx);
    assert.equal(app.customMessages.length, 1, "stale rule is removed from the runtime index");
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("active advisory delivery rearms after compaction and resets at a new task", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-lifecycle-"));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent"),
    memory = activatedNote();
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: true });
    await writeJsonAtomic(join(agentDir, "pi-continuity", "memory-v6", "state.json"), {
      ...emptyMemoryState(),
      revision: 1,
      notes: [memory],
      updatedAt: new Date().toISOString(),
    });
    let branch: any[] = [];
    const app = runtime(["edit", "continuity_update"]),
      ctx: any = {
        cwd,
        hasUI: false,
        mode: "json",
        signal: undefined,
        sessionManager: {
          getSessionId: () => "memory-lifecycle",
          getSessionFile: () => undefined,
          getEntries: () => [],
          getBranch: () => branch,
          buildContextEntries: () => [],
        },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const toolCall = app.handlers.get("tool_call")![0];
    await toolCall({ toolName: "edit", toolCallId: "first", input: { path: "src/generated/client.ts" } }, ctx);
    assert.equal(app.customMessages.length, 1);
    await toolCall({ toolName: "edit", toolCallId: "same-task", input: { path: "src/generated/other.ts" } }, ctx);
    assert.equal(app.customMessages.length, 1, "visible active memory is not repeated");
    branch = app.appended.map(entry => ({ type: "custom", ...entry }));
    for (const handler of app.handlers.get("session_tree") ?? []) await handler({}, ctx);
    for (const handler of app.handlers.get("session_compact") ?? []) await handler({}, ctx);
    assert.equal(app.customMessages.length, 2);
    assert.match(app.customMessages[1]!.message.content, /Edit the generator instead/);
    for (const handler of app.handlers.get("input") ?? []) handler({ source: "interactive", text: "new task" });
    await toolCall({ toolName: "edit", toolCallId: "new-task", input: { path: "src/generated/new.ts" } }, ctx);
    assert.equal(
      app.customMessages.length,
      2,
      "a new task does not duplicate a rule that remains visible in the same context epoch",
    );
    assert.ok(app.appended.some(entry => entry.customType === "pi-continuity-memory-ledger-v1"));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("manual and automatic compaction always use deterministic Continuity output", async () => {
  await saveConfig({ version: 2, memoryEnabled: true });
  const app = runtime();
  const compact = app.handlers.get("session_before_compact")![0];
  const message = (id: string, role: string, text: string, parentId: string | null) => ({
    id,
    parentId,
    type: "message",
    timestamp: Date.now(),
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
    reason,
    willRetry: false,
    customInstructions,
    signal,
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
    id,
    parentId,
    type: "message",
    timestamp: Date.now(),
    message: { role, content: [{ type: "text", text }], timestamp: Date.now() },
  });
  const branch = [
    message("current", "user", "Current request", null),
    message("suffix-1", "assistant", "x".repeat(20_000), "current"),
    message("suffix-2", "assistant", "y".repeat(20_000), "suffix-1"),
  ];
  const preparation = { firstKeptEntryId: "current", tokensBefore: 42_000, settings: { keepRecentTokens: 50_000 } };
  for (const reason of ["manual", "threshold"]) {
    const result = await compact(
      { branchEntries: branch, preparation, reason, willRetry: false, signal: new AbortController().signal },
      { modelRegistry: { find: () => undefined }, ui: { notify: () => {} } },
    );
    assert.equal(result.compaction.firstKeptEntryId, "suffix-2");
    assert.equal(preparation.settings.keepRecentTokens, 50_000, "incoming Pi preparation remains unchanged");
  }
});

test("over-threshold tool work compacts and resumes through public extension APIs", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-mid-task-compact-"));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: false, keepRecentTokens: 50_000 });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { enabled: true, reserveTokens: 30_000 } }),
    );
    const app = runtime();
    const compactCalls: any[] = [];
    const ctx: any = {
      cwd,
      hasUI: false,
      mode: "json",
      signal: new AbortController().signal,
      isIdle: () => true,
      isProjectTrusted: () => false,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 250_000, contextWindow: 272_000, percent: 91.9 }),
      compact: (options: any) => compactCalls.push(options),
      sessionManager: {
        getSessionId: () => "mid-task-session",
        getSessionFile: () => undefined,
        getEntries: () => [],
        getBranch: () => [],
        buildContextEntries: () => [],
      },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const turnCtx = { ...ctx };
    assert.notEqual(turnCtx, ctx);
    for (const handler of app.handlers.get("tool_execution_end") ?? [])
      await handler({ toolCallId: "call-1", result: { terminate: false } }, turnCtx);
    for (const handler of app.handlers.get("turn_end") ?? [])
      await handler(
        {
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          },
          toolResults: [{ role: "toolResult", toolCallId: "call-1" }],
        },
        turnCtx,
      );

    assert.equal(compactCalls.length, 1, "custom reserveTokens threshold should trigger before Pi's default threshold");
    const duplicateAutoCompact = await app.handlers.get("session_before_compact")![0]({ reason: "threshold" }, ctx);
    assert.deepEqual(duplicateAutoCompact, { cancel: true });
    const requestId = app.emitted.find(event => event.channel === "pi-continuity:compaction-continuation")!.value
      .requestId;
    const messageEnd = app.handlers.get("message_end")![0];
    for (const errorMessage of ["This operation was aborted", "request was aborted."]) {
      const interruption = { role: "assistant", stopReason: "error", errorMessage, content: [] };
      const annotated = await messageEnd({ message: interruption }, ctx);
      assert.equal(annotated.message.stopReason, "aborted");
      assert.equal(annotated.message.errorMessage, errorMessage);
      assert.equal(annotated.message.diagnostics.at(-1).details.requestId, requestId);
    }
    assert.equal(
      await messageEnd(
        { message: { role: "assistant", stopReason: "error", errorMessage: "Provider rejected request", content: [] } },
        ctx,
      ),
      undefined,
      "unrelated provider errors remain terminal",
    );
    assert.equal(app.customMessages.length, 0);
    compactCalls[0].onComplete();
    assert.equal(app.customMessages.length, 1);
    assert.deepEqual(app.customMessages[0].options, { triggerTurn: true });
    assert.equal(app.customMessages[0].message.customType, "pi-continuity-resume");
    assert.equal(app.customMessages[0].message.display, false);
    assert.match(app.customMessages[0].message.content, /Continue the unfinished task/);
    const lifecycle = app.emitted.filter(event => event.channel === "pi-continuity:compaction-continuation");
    assert.equal(lifecycle.length, 2);
    assert.equal(lifecycle[0]!.value.action, "begin");
    assert.equal(lifecycle[1]!.value.action, "resume");
    assert.equal(lifecycle[1]!.value.requestId, lifecycle[0]!.value.requestId);
    assert.equal(app.customMessages[0].message.details.requestId, lifecycle[0]!.value.requestId);
    const laterUserAbort = { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] };
    const laterAnnotation = await messageEnd({ message: laterUserAbort }, ctx);
    assert.equal(laterAnnotation, undefined, "completed continuation no longer annotates unrelated user aborts");

    for (const handler of app.handlers.get("tool_execution_end") ?? [])
      await handler({ toolCallId: "send-failure", result: { terminate: false } }, turnCtx);
    for (const handler of app.handlers.get("turn_end") ?? [])
      await handler(
        {
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "send-failure", name: "read", arguments: {} }],
          },
          toolResults: [{ role: "toolResult", toolCallId: "send-failure" }],
        },
        turnCtx,
      );
    app.failNextSend();
    compactCalls.at(-1).onComplete();
    assert.equal(app.customMessages.length, 1);
    assert.equal(
      app.emitted.filter(event => event.channel === "pi-continuity:compaction-continuation").at(-1)?.value.action,
      "abandon",
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("mid-task compaction respects termination, cancellation, pending input, failure, and shutdown", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-mid-task-guards-"));
  const cwd = join(root, "repo"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 2, memoryEnabled: false });
    const app = runtime();
    const compactCalls: any[] = [];
    let pending = false,
      compactThrows = false;
    const ctx: any = {
      cwd,
      hasUI: false,
      mode: "json",
      signal: new AbortController().signal,
      isIdle: () => true,
      isProjectTrusted: () => false,
      hasPendingMessages: () => pending,
      getContextUsage: () => ({ tokens: 260_000, contextWindow: 272_000, percent: 95.6 }),
      compact: (options: any) => {
        if (compactThrows) throw Error("synchronous compact failure");
        compactCalls.push(options);
      },
      sessionManager: {
        getSessionId: () => "guarded-mid-task-session",
        getSessionFile: () => undefined,
        getEntries: () => [],
        getBranch: () => [],
        buildContextEntries: () => [],
      },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    const finishToolTurn = async (id: string, terminate = false) => {
      for (const handler of app.handlers.get("tool_execution_end") ?? [])
        await handler({ toolCallId: id, result: { terminate } }, ctx);
      for (const handler of app.handlers.get("turn_end") ?? [])
        await handler(
          {
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [{ type: "toolCall", id, name: "read", arguments: {} }],
            },
            toolResults: [{ role: "toolResult", toolCallId: id }],
          },
          ctx,
        );
    };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);

    for (const handler of app.handlers.get("turn_end") ?? [])
      await handler(
        {
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
          toolResults: [{ role: "toolResult", toolCallId: "not-a-tool-turn" }],
        },
        ctx,
      );
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
    const cancelledRequest = app.emitted
      .filter(event => event.channel === "pi-continuity:compaction-continuation")
      .at(-1)!.value;
    app.emit("pi-continuity:compaction-continuation", { ...cancelledRequest, action: "cancel" });
    const cancelledError = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "This operation was aborted",
      content: [],
    };
    assert.equal(
      await app.handlers.get("message_end")![0]({ message: cancelledError }, ctx),
      undefined,
      "scoped cancellation clears the request before an abort-shaped provider result",
    );
    compactCalls[0].onComplete();
    assert.equal(app.customMessages.length, 0);
    await finishToolTurn("after-cancel");
    assert.equal(compactCalls.length, 2);

    await finishToolTurn("terminating-after-request", true);
    compactCalls[1].onComplete();
    assert.equal(app.customMessages.length, 0, "a later terminating batch invalidates the superseded continuation");
    assert.equal(
      app.emitted.filter(event => event.channel === "pi-continuity:compaction-continuation").at(-1)?.value.action,
      "abandon",
    );

    await finishToolTurn("failed-compaction");
    assert.equal(compactCalls.length, 3);
    compactCalls[2].onError(new Error("failed"));
    assert.equal(app.customMessages.length, 0);
    assert.equal(
      app.emitted.filter(event => event.channel === "pi-continuity:compaction-continuation").at(-1)?.value.action,
      "abandon",
    );

    compactThrows = true;
    await finishToolTurn("synchronous-failure");
    compactThrows = false;
    assert.equal(compactCalls.length, 3);
    assert.equal(
      app.emitted.filter(event => event.channel === "pi-continuity:compaction-continuation").at(-1)?.value.action,
      "abandon",
    );

    await finishToolTurn("pending-request");
    assert.equal(compactCalls.length, 4);
    pending = true;
    await finishToolTurn("pending-invalidates-request");
    pending = false;
    compactCalls[3].onComplete();
    assert.equal(app.customMessages.length, 0, "queued input invalidates the superseded continuation");

    await finishToolTurn("shutdown");
    assert.equal(compactCalls.length, 5);
    for (const handler of app.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    compactCalls[4].onComplete();
    assert.equal(app.customMessages.length, 0);
    assert.equal(
      app.emitted.filter(event => event.channel === "pi-continuity:compaction-continuation").at(-1)?.value.action,
      "abandon",
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("session recall tool is sequential, read-only, and handles ephemeral state without side effects", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-recall-extension-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let persisted = false;
  let getEntriesCalls = 0;
  const visible = [
    {
      id: "visible",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: "Visible evidence", timestamp: Date.now() },
    },
  ];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: {
      getSessionId: () => "recall-session",
      getSessionFile: () => (persisted ? join(root, "session.jsonl") : undefined),
      getEntries: () => {
        getEntriesCalls++;
        return visible;
      },
      getBranch: () => visible,
      buildContextEntries: () => visible,
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    const recall = app.tools.get("continuity_recall");
    for (const handler of app.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

    const historical = SessionManager.create(cwd);
    historical.appendMessage({ role: "user", content: "Historical project-session marker", timestamp: Date.now() });
    historical.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Historical response" }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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

    await app.tools
      .get("continuity_update")
      .execute("plan", { action: "set_plan", goal: "Recall", todos: ["Recall history"] }, undefined, undefined, ctx);

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
    const result = await tool.execute(
      "repeated",
      { action: "state", todoIds: ["todo_1"], status: "done" },
      undefined,
      undefined,
      {},
    );
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
    cwd,
    hasUI: false,
    mode: "json",
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
      "complete-with-reply",
      { action: "state", completion: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(stopped.content[0].text, /Cannot complete while todos remain/);
    assert.equal(stopped.terminate, true);

    content = [{ type: "toolCall", id: "complete-tool-only", name: "continuity_update" }];
    const recoverable = await tool.execute(
      "complete-tool-only",
      { action: "state", completion: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(recoverable.content[0].text, /Cannot complete while todos remain/);
    assert.equal(recoverable.terminate, undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("unchanged Continuity context keeps a stable prefix across tool turns", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-stable-context-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "stable-context-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Inspect", todos: ["Answer"] }, undefined, undefined, ctx);
    const contextHook = app.handlers.get("context")![0]!;
    const userMessage = { role: "user", content: [{ type: "text", text: "Start" }], timestamp: 1 };

    const first = contextHook({ messages: [userMessage] }, ctx);
    assert.equal(first.messages[1].customType, "pi-continuity");

    const firstToolTurn = [
      userMessage,
      { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], timestamp: 2 },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 3,
      },
    ];
    const second = contextHook({ messages: firstToolTurn }, ctx);
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.equal(second.messages.filter((message: any) => message.customType === "pi-continuity").length, 1);

    await tool.execute("state", { action: "state", nextAction: "Review the result" }, undefined, undefined, ctx);
    const changed = contextHook({ messages: firstToolTurn }, ctx);
    assert.equal(changed.messages.at(-1).customType, "pi-continuity");
    assert.notEqual(changed.messages.at(-1).content, first.messages[1].content);

    const secondToolTurn = [
      ...firstToolTurn,
      { role: "assistant", content: [{ type: "toolCall", id: "read-2", name: "read", arguments: {} }], timestamp: 4 },
      {
        role: "toolResult",
        toolCallId: "read-2",
        toolName: "read",
        content: [{ type: "text", text: "result 2" }],
        isError: false,
        timestamp: 5,
      },
    ];
    const afterChange = contextHook({ messages: secondToolTurn }, ctx);
    assert.deepEqual(afterChange.messages.slice(0, changed.messages.length), changed.messages);
    assert.equal(afterChange.messages.filter((message: any) => message.customType === "pi-continuity").length, 1);
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
    cwd,
    hasUI: false,
    mode: "json",
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

    await messageEnd?.(
      {
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Not final" },
            { type: "toolCall", id: "call", name: "read", arguments: {} },
          ],
        },
      },
      ctx,
    );
    let context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    await messageEnd?.(
      { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Not final" }] } },
      ctx,
    );
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    await messageEnd?.(
      { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } },
      ctx,
    );
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

test("automatic completion waits for required verification but accepts a stale result", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-auto-verify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
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
    const finalMessage = {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] },
    };
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    let blocked = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);

    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "failed",
      runId: "failed",
      results: [{ command: "npm test", code: 1 }],
    });
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    assert.deepEqual(app.sent, [], "failed Verify final must not schedule another turn");
    let context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);
    assert.match(context.messages.at(-1).content, /Verification failed/);
    blocked = await tool.execute(
      "complete",
      { action: "state", completion: true, allowUnverified: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(blocked.content[0].text, /Cannot complete until/);
    assert.equal(blocked.terminate, undefined);

    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "stale",
      runId: "stale",
      results: [],
    });
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    blocked = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /already completed/i);
    assert.equal(blocked.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});
