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

test("plan mode permits memory list but blocks memory mutations", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-memory-plan-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    isIdle: () => true,
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
    assert.match(
      (await guard({ toolName: "memory", input: { action: "add" } }, ctx)).reason,
      /Memory mutations are blocked.*list only/i,
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("session startup safely reassociates a moved repository and retains a backup", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-v6-owner-startup-")),
    oldPath = join(root, "old"),
    cwd = join(root, "moved");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(oldPath);
    await exec("git", ["init", "-q"], { cwd: oldPath });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: oldPath });
    await exec("git", ["config", "user.name", "Test"], { cwd: oldPath });
    await writeFile(join(oldPath, "one.txt"), "one\n");
    await exec("git", ["add", "."], { cwd: oldPath });
    await exec("git", ["commit", "-m", "one"], { cwd: oldPath });
    const first = String((await exec("git", ["rev-parse", "HEAD"], { cwd: oldPath })).stdout).trim();
    await writeFile(join(oldPath, "two.txt"), "two\n");
    await exec("git", ["add", "."], { cwd: oldPath });
    await exec("git", ["commit", "-m", "two"], { cwd: oldPath });
    const second = String((await exec("git", ["rev-parse", "HEAD"], { cwd: oldPath })).stdout).trim();
    const oldOwner = (await projectContext(oldPath, "fallback")).owner,
      id = serverNoteId(),
      continuityRoot = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity"),
      statePath = join(continuityRoot, "memory-v6", "state.json");
    await writeJsonAtomic(join(continuityRoot, "workspaces.json"), [
      {
        id: "old-workspace",
        canonicalPath: oldPath,
        projectOwner: oldOwner,
        createdAt: "2020-01-01T00:00:00Z",
        lastSeenAt: "2020-01-01T00:00:00Z",
      },
    ]);
    await writeJsonAtomic(statePath, {
      ...emptyMemoryState(),
      revision: 1,
      updatedAt: new Date().toISOString(),
      notes: [
        {
          id,
          scope: "project",
          owner: oldOwner,
          trigger: "changing the boundary",
          guidance: "Preserve it.",
          authority: "project_contract",
          origin: "agent",
          sourceRefs: [
            { type: "repository", path: "one.txt", excerptSha256: "a".repeat(64), captureCommit: first },
            { type: "repository", path: "two.txt", excerptSha256: "b".repeat(64), captureCommit: second },
          ],
          disposition: "archival",
          enforcementAuthority: "context_only",
          revision: 1,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
    });
    await rename(oldPath, cwd);
    const ctx: any = {
      cwd,
      hasUI: false,
      mode: "json",
      sessionManager: { getSessionId: () => "owner-move-session", getEntries: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    };
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const currentOwner = (await projectContext(cwd, "fallback")).owner,
      state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.notes[0]?.owner, currentOwner);
    assert.equal(state.notes[0]?.revision, 2);
    assert.equal(state.audits?.at(-1)?.type, "owner_reassociation");
    assert.equal(isMemoryState(state), true);
    const backups = await readdir(join(continuityRoot, "memory-v6", "backups"));
    assert.ok(backups.some(name => name.startsWith("owner-reassociation-")));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit V4 migration command requires UI confirmation and a reviewer", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-v6-migrate-command-")),
    cwd = join(root, "repo");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(cwd);
    await exec("git", ["init", "-q"], { cwd });
    const continuityRoot = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity");
    await writeJsonAtomic(join(continuityRoot, "memory-v4", "memory.json"), { schemaVersion: 4, facts: [] });
    await writeJsonAtomic(join(continuityRoot, "memory-v4", "candidates.json"), { schemaVersion: 4, candidates: [] });
    const notices: string[] = [];
    let confirmed = false;
    const ctx: any = {
      cwd,
      hasUI: false,
      mode: "json",
      sessionManager: { getSessionId: () => "migrate-command-session", getEntries: () => [] },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
      ui: {
        notify: (message: string) => notices.push(message),
        setStatus: () => {},
        setWidget: () => {},
        confirm: async () => confirmed,
      },
    };
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    let snapshot: any;
    app.emit("pi-continuity:state-request", {
      version: 4,
      sessionId: "migrate-command-session",
      respond: (value: unknown) => {
        snapshot = value;
      },
    });
    assert.equal(snapshot.v4MigrationAvailable, true);
    let response: Promise<unknown> | undefined;
    app.emit("pi-continuity:memory-mutation", {
      version: 2,
      sessionId: "migrate-command-session",
      expectedGeneration: 1,
      action: "migrate",
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    await assert.rejects(response!, /Memory Reviewer is not configured/);
    app.emit("pi-continuity:memory-mutation", {
      version: 2,
      sessionId: "migrate-command-session",
      expectedGeneration: 1,
      action: "migrate",
      scope: "user",
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    await assert.rejects(response!, /invalid memory migration fields/);
    const command = app.commands.get("memory").handler;
    await command("migrate-v4", ctx);
    assert.match(notices.at(-1) ?? "", /Interactive UI required/);
    ctx.hasUI = true;
    await command("migrate-v4", ctx);
    assert.doesNotMatch(notices.at(-1) ?? "", /migration failed/i);
    confirmed = true;
    await command("migrate-v4", ctx);
    assert.match(notices.at(-1) ?? "", /Memory Reviewer is not configured/);
    assert.equal(
      JSON.parse(await readFile(join(continuityRoot, "memory-v6", "migration.json"), "utf8")).status,
      "pending",
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive memory edit, forget, project purge, and rollback persist V6 state and audit", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-v6-memory-commands-")),
    cwd = join(root, "repo");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const userId = "00000000-0000-4000-8000-000000000001",
    projectId = "00000000-0000-4000-8000-000000000002",
    foreignId = "00000000-0000-4000-8000-000000000003";
  try {
    await mkdir(cwd);
    await exec("git", ["init", "-q"], { cwd });
    const owner = (await projectContext(cwd, "fallback")).owner;
    const statePath = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "state.json");
    const note = (id: string, scope: "user" | "project", noteOwner: string) => ({
      id,
      scope,
      owner: noteOwner,
      trigger: "replying to a request",
      guidance: "Keep replies concise.",
      authority: scope === "user" ? "user_instruction" : "project_contract",
      origin: "user",
      sourceRefs: [{ type: "direct_user_edit" as const }],
      disposition: "archival" as const,
      enforcementAuthority: "context_only" as const,
      revision: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    await writeJsonAtomic(statePath, {
      ...emptyMemoryState(),
      revision: 1,
      updatedAt: new Date().toISOString(),
      notes: [
        note(userId, "user", "default"),
        note(projectId, "project", owner),
        note(foreignId, "project", "other-owner"),
      ],
    });
    const notices: string[] = [],
      confirmations: string[] = [];
    let editorCalls = 0;
    const ctx: any = {
      cwd,
      hasUI: true,
      mode: "tui",
      sessionManager: { getSessionId: () => "memory-command-session", getEntries: () => [] },
      ui: {
        notify: (message: string) => notices.push(message),
        setStatus: () => {},
        setWidget: () => {},
        confirm: async (title: string) => {
          confirmations.push(title);
          return true;
        },
        editor: async () => {
          editorCalls++;
          if (editorCalls === 2) {
            const current = JSON.parse(await readFile(statePath, "utf8"));
            current.revision++;
            current.notes = current.notes.map((item: any) =>
              item.id === userId ? { ...item, revision: item.revision + 1 } : item,
            );
            await writeJsonAtomic(statePath, current);
          }
          return "Trigger:\nreplying to a request\n\nGuidance:\nUse compact answers.";
        },
      },
    };
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const command = app.commands.get("memory").handler;
    await command(`edit user ${userId}`, ctx);
    let state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.notes.find((item: any) => item.id === userId)?.guidance, "Use compact answers.");
    assert.equal(state.notes.find((item: any) => item.id === userId)?.revision, 2);
    assert.equal(state.audits?.at(-1)?.type, "direct_edit");
    await command(`edit user ${userId}`, ctx);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.notes.find((item: any) => item.id === userId)?.revision, 3);
    assert.ok(notices.some(message => /changed/i.test(message)));
    await command(`forget user ${userId}`, ctx);
    await command("forget project", ctx);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(
      state.notes.some((item: any) => item.id === userId),
      false,
    );
    assert.equal(
      state.notes.some((item: any) => item.id === projectId),
      false,
    );
    assert.equal(
      state.notes.some((item: any) => item.id === foreignId),
      true,
    );
    const backupPath = join(
      process.env.PI_CODING_AGENT_DIR!,
      "pi-continuity",
      "memory-v6",
      "backups",
      "pre-migration.json",
    );
    await writeJsonAtomic(backupPath, emptyMemoryState());
    await writeJsonAtomic(join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "migration.json"), {
      version: 1,
      sourceHashes: {},
      status: "activated",
      completedRecordIds: [],
      reviewerBatchIds: [],
      activatedStateRevision: state.revision,
      preMigrationBackup: backupPath,
      retryCount: 0,
      diagnostics: [],
    });
    await command("rollback", ctx);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(isMemoryState(state), true);
    assert.deepEqual(state.notes, []);
    const journal = JSON.parse(
      await readFile(join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "migration.json"), "utf8"),
    );
    assert.equal(journal.status, "rolled_back");
    assert.deepEqual(confirmations, [
      "Save user memory?",
      "Save user memory?",
      "Forget user memory?",
      "Forget all project memory?",
      "Rollback Memory V6 migration?",
    ]);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("review settlement rechecks provenance and rejects stale generations", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR,
    root = await mkdtemp(join(tmpdir(), "continuity-v6-settlement-")),
    cwd = join(root, "repo");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(cwd);
    await exec("git", ["init"], { cwd });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd });
    await exec("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "file.txt"), "one\n");
    await exec("git", ["add", "."], { cwd });
    await exec("git", ["commit", "-m", "initial"], { cwd });
    await writeFile(join(cwd, "file.txt"), "two\n");
    const branch: any[] = [
      { id: "tool-result", type: "message", message: { role: "toolResult", toolCallId: "memory-call", content: [] } },
    ];
    const app = runtime(["memory", "continuity_update"]),
      ctx: any = {
        cwd,
        hasUI: false,
        mode: "json",
        modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
        sessionManager: {
          getSessionId: () => "settlement-session",
          getSessionFile: () => "session.jsonl",
          getEntries: () => [],
          getBranch: () => branch,
          buildContextEntries: () => [],
        },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      };
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const owner = (await projectContext(cwd, "fallback")).owner,
      created = serverNoteId(),
      activationDraft = archivalActivationDraft();
    const review: ReviewRecord = {
      reviewId: serverReviewId(),
      sessionId: "settlement-session",
      toolCallId: "memory-call",
      projectOwner: owner,
      reviewedAt: new Date().toISOString(),
      status: "approved_pending",
      verificationStatus: {
        status: "verified",
        verifiedAt: new Date().toISOString(),
        sourceSnapshotId: "a".repeat(64),
      },
      generation: 1,
      taskGeneration: 1,
      operations: [
        {
          operation: "add",
          noteId: created,
          scope: "project",
          owner,
          trigger: "changing the boundary",
          guidance: "Preserve the documented boundary.",
          authority: "project_contract",
          sourceRefs: [],
          disposition: "archival",
          enforcementAuthority: "context_only",
          activationDraft,
          rawProposal: { trigger: "changing the boundary", guidance: "Preserve the documented boundary." },
          rewriteCharacter: "format_only",
        },
      ],
      rejectionCounts: {},
    };
    const statePath = join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6", "state.json");
    const pendingState = { ...emptyMemoryState(), revision: 1, reviews: [review], updatedAt: new Date().toISOString() };
    assert.equal(isMemoryState(pendingState), true);
    await writeJsonAtomic(statePath, pendingState);
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    const stateEntries = await readdir(join(process.env.PI_CODING_AGENT_DIR!, "pi-continuity", "memory-v6"));
    assert.ok(stateEntries.includes("state.json"), `state entries: ${stateEntries.join(", ")}`);
    const committed = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(committed.notes[0]?.id, created);
    assert.equal(committed.reviews[0]?.status, "committed");
    const stale = {
      ...review,
      reviewId: serverReviewId(),
      toolCallId: "stale-call",
      generation: 0,
      status: "approved_pending" as const,
      operations: [],
    };
    branch.push({
      id: "stale-result",
      type: "message",
      message: { role: "toolResult", toolCallId: "stale-call", content: [] },
    });
    const staleState = { ...committed, reviews: [...committed.reviews, stale] };
    assert.equal(isReviewRecord(stale), true, JSON.stringify(stale));
    assert.equal(committed.reviews.every(isReviewRecord), true, JSON.stringify(committed.reviews));
    assert.equal(committed.notes.every(isNotebookNote), true, JSON.stringify(committed.notes));
    assert.equal(isMemoryState(staleState), true, JSON.stringify(staleState));
    await writeJsonAtomic(statePath, staleState);
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    const discarded = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(discarded.reviews.find((item: any) => item.reviewId === stale.reviewId)?.status, "discarded");
    let response: Promise<unknown> | undefined;
    app.emit("pi-continuity:memory-mutation", {
      version: 2,
      sessionId: "settlement-session",
      expectedGeneration: 1,
      action: "update",
      scope: "project",
      id: created,
      trigger: "changing the boundary",
      guidance: "Preserve the reviewed boundary.",
      expectedRevision: 1,
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    await response;
    const edited = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(edited.notes[0]?.revision, 2);
    assert.equal(edited.notes[0]?.origin, "user");
    app.emit("pi-continuity:memory-mutation", {
      version: 2,
      sessionId: "settlement-session",
      expectedGeneration: 0,
      action: "delete",
      scope: "project",
      id: created,
      expectedRevision: 2,
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    await assert.rejects(response!, /stale/);
    app.emit("pi-continuity:memory-mutation", {
      version: 2,
      sessionId: "settlement-session",
      expectedGeneration: 1,
      action: "delete",
      scope: "project",
      owner: "forged",
      id: created,
      expectedRevision: 2,
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    await assert.rejects(response!, /fields/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
