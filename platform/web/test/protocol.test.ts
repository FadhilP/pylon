import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_FRAME_INTERVAL_MS, IDLE_FRAME_INTERVAL_MS, framePollingDelay } from "../src/shared/browser-polling.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import { validateHeliosBrowserCommand } from "../src/shared/protocol/helios.ts";
import { describeRuntimeSnapshotIssue, isArchiveListSnapshot, isConversationHistoryPage, isConversationTurnIndexPage, isFileSuggestionList, isHookSettingsSnapshot, isPackageListSnapshot, isRuntimeSnapshot, isSessionListSnapshot, isStateQLSnapshot, isWebEvent, isWorkspaceFileContent, isWorkspaceFilePage, runtimeSnapshotValidationIssue, validateCommand } from "../src/shared/protocol/validation.ts";

test("hook settings protocol accepts bounded exact settings", () => {
  const settings = {
    sessionStart: { enabled: true, sources: [{ id: "start", name: "Start", kind: "text", content: "hello" }] },
    beforeAgentStart: { enabled: false, sources: [] },
  };
  assert.equal(validateCommand({ type: "updateHookSettings", settings, commandId: "hooks", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updateHookSettings", settings: { ...settings, extra: true }, commandId: "hooks", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateHookSettings", settings: { ...settings, sessionStart: { ...settings.sessionStart, sources: [{ ...settings.sessionStart.sources[0], content: "x".repeat(64 * 1024 + 1) }] } }, commandId: "hooks", expectedGeneration: 1 }).ok, false);
  assert.equal(isHookSettingsSnapshot({ protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, settings }), true);
});

test("embedded browser polling is fast only during recent activity", () => {
  assert.equal(framePollingDelay(1_000, 1_001), ACTIVE_FRAME_INTERVAL_MS);
  assert.equal(framePollingDelay(1_000, 1_000), IDLE_FRAME_INTERVAL_MS);
});

test("command validation allowlists bounded v26 commands and attachments", () => {
  const valid = validateCommand({
    type: "prompt",
    commandId: "command-1",
    expectedGeneration: 2,
    message: "hello",
  });
  assert.equal(valid.ok, true);
  assert.equal(validateCommand({ ...valid.ok && valid.value, type: "unknown" }).ok, false);
  assert.equal(validateCommand({ type: "abort", commandId: "x", expectedGeneration: 0 }).ok, false);
  assert.equal(validateCommand({
    type: "prompt",
    commandId: "x",
    expectedGeneration: 1,
    message: "x".repeat(64 * 1024 + 1),
  }).ok, false);
  assert.equal(validateCommand({ type: "timeline", action: "restore", checkpointId: "session:checkpoint", commandId: "timeline", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "timeline", action: "fork", checkpointId: "bad id\n/clear", commandId: "timeline", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "timeline", action: "clear", checkpointId: "unexpected", commandId: "timeline", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "setPackageEnabled", packageId: "pi-verify", enabled: false, commandId: "package", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setPackageEnabled", packageId: "", enabled: false, commandId: "package", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "setPackageEnabled", packageId: "pi-verify", enabled: "yes", commandId: "package", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updatePackageSettings", packageId: "pi-advisor", settings: { kind: "advisor", mode: "session", thinking: "high" }, commandId: "settings", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updatePackageSettings", packageId: "pi-sieve", settings: { kind: "sieve", activePruning: true, threshold: 8_000, projectionMode: "stable", rolloverHighMultiplier: 8, rolloverLowMultiplier: 4 }, commandId: "settings", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updatePackageSettings", packageId: "pi-sieve", settings: { kind: "sieve", activePruning: true, threshold: 999, projectionMode: "stable", rolloverHighMultiplier: 8, rolloverLowMultiplier: 4 }, commandId: "settings", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updatePackageSettings", packageId: "pi-sieve", settings: { kind: "sieve", activePruning: true, threshold: 8_000, projectionMode: "invalid", rolloverHighMultiplier: 8, rolloverLowMultiplier: 4 }, commandId: "settings", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updatePackageSettings", packageId: "pi-sieve", settings: { kind: "sieve", activePruning: true, threshold: 8_000, projectionMode: "stable", rolloverHighMultiplier: 4, rolloverLowMultiplier: 4 }, commandId: "settings", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "rebuildDiscoverIndex", commandId: "index", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({
    type: "applySessionChanges",
    commandId: "apply",
    expectedGeneration: 1,
    expectedRevision: "revision-1",
  }).ok, true);
  assert.equal(validateCommand({
    type: "applySessionChanges",
    commandId: "apply",
    expectedGeneration: 1,
    expectedRevision: "",
  }).ok, false);
  assert.equal(validateCommand({ type: "setModel", provider: "openai", modelId: "gpt-5", commandId: "model", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setModel", provider: "", modelId: "gpt-5", commandId: "model", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "setThinkingLevel", level: "high", commandId: "thinking", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setThinkingLevel", level: "extreme", commandId: "thinking", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "setSessionControls", provider: "openai", modelId: "gpt-5", thinkingLevel: "high", commandId: "controls", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setSessionControls", provider: "openai", modelId: "gpt-5", thinkingLevel: "extreme", commandId: "controls", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "deleteSession", sessionId: "session-1", commandId: "delete", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "deleteSession", sessionId: "", commandId: "delete", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "renameSession", sessionId: "session-1", name: "New name", commandId: "rename", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "renameSession", sessionId: "session-1", name: " ", commandId: "rename", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "setSessionActive", sessionId: "session-1", active: true, commandId: "active", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setSessionActive", sessionId: "session-1", active: "yes", commandId: "active", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "setSessionPinned", sessionId: "session-1", pinned: true, commandId: "pin", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setSessionPinned", sessionId: "session-1", pinned: "yes", commandId: "pin", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "editPrompt", entryId: "entry-1", message: "Updated", rollbackFiles: false, commandId: "edit", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "editPrompt", entryId: "", message: "Updated", rollbackFiles: false, commandId: "edit", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "editPrompt", entryId: "entry-1", message: "Updated", rollbackFiles: "yes", commandId: "edit", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "rewindPrompt", entryId: "entry-1", commandId: "rewind", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "rewindPrompt", entryId: "", commandId: "rewind", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "addProject", commandId: "project", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "removeProject", projectId: "project-one", commandId: "project", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "renameProject", projectId: "project-one", name: "Renamed", commandId: "rename-project", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "renameProject", projectId: "project-one", name: " ", commandId: "rename-project", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "renameProject", projectId: "project-one", name: "bad\nname", commandId: "rename-project", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "reorderProject", projectId: "project-one", beforeProjectId: "project-two", commandId: "project-order", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "reorderProject", projectId: "project-one", beforeProjectId: "", commandId: "project-order", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "archiveProject", projectId: "project-one", commandId: "archive-project", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "restoreSession", sessionId: "session-one", commandId: "restore-session", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "reorderActiveSession", sessionId: "session-one", beforeSessionId: "session-two", commandId: "session-order", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "archiveSession", sessionId: "x".repeat(129), commandId: "archive-session", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "newSession", projectId: "project-one", parentSessionId: "session-1", commandId: "new", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateContinuityMemory", key: "project.arch", text: "Use the coordinator", kind: "architecture", expectedUpdatedAt: new Date(0).toISOString(), commandId: "memory", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updateContinuityMemory", key: "project.arch", text: "", kind: "architecture", expectedUpdatedAt: new Date(0).toISOString(), commandId: "memory", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updatePackageSettings", packageId: "pi-timeline", settings: { kind: "timeline", editRollbackDefault: false }, commandId: "timeline-settings", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "handoffSession", destination: "checkout", commandId: "handoff", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "handoffSession", destination: "merge", commandId: "handoff", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateProjectWorktreeSettings", projectId: "project-one", setupCommand: "npm install", commandId: "setup", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updateProjectWorktreeSettings", projectId: "project-one", setupCommand: "x".repeat(2_001), commandId: "setup", expectedGeneration: 1 }).ok, false);
  const dialogTimeouts = { guardTimeoutSeconds: 60, clarifyTimeoutSeconds: null };
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "project", verify: { mode: "auto" }, timeline: "enabled", guard: "enabled", workspace: "local", ...dialogTimeouts, expectedRevision: 0, commandId: "policy", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "global", verify: { mode: "inherit" }, timeline: "enabled", guard: "enabled", workspace: "local", ...dialogTimeouts, expectedRevision: 0, commandId: "global-policy", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "global", verify: { mode: "auto" }, timeline: "enabled", guard: "enabled", workspace: "local", ...dialogTimeouts, expectedRevision: 0, commandId: "bad-global-policy", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "project", verify: { mode: "auto" }, timeline: "enabled", guard: "enabled", workspace: "automatic", ...dialogTimeouts, expectedRevision: 0, commandId: "policy", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "session", verify: { mode: "selected", checks: ["npm:test"] }, timeline: "inherit", guard: "inherit", workspace: "local", guardTimeoutSeconds: "inherit", clarifyTimeoutSeconds: 15, expectedRevision: 1, commandId: "policy", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "project", verify: { mode: "inherit" }, timeline: "inherit", guard: "inherit", workspace: "inherit", ...dialogTimeouts, expectedRevision: 0, commandId: "policy", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "session", verify: { mode: "selected", checks: Array(7).fill("check") }, timeline: "enabled", guard: "enabled", workspace: "worktree", ...dialogTimeouts, expectedRevision: 0, commandId: "policy", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "project", verify: { mode: "auto" }, timeline: "enabled", guard: "enabled", workspace: "local", guardTimeoutSeconds: 14, clarifyTimeoutSeconds: 60, expectedRevision: 0, commandId: "policy", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "updateRuntimePolicy", scope: "project", verify: { mode: "auto" }, timeline: "enabled", guard: "enabled", workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 86_401, expectedRevision: 0, commandId: "policy", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "dismissCommandResult", resultId: "result-1", commandId: "dismiss", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "fork", entryId: "prompt-1", mode: "timeline", name: "Investigate fix", commandId: "fork", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "fork", entryId: "prompt-1", mode: "conversation", name: " ", commandId: "fork", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "fork", entryId: "prompt-1", mode: "conversation", name: "x".repeat(201), commandId: "fork", expectedGeneration: 1 }).ok, false);
  const image = { mimeType: "image/png", data: Buffer.from("image").toString("base64") };
  const file = { name: "notes.txt", mimeType: "text/plain", text: "context", size: 7 };
  assert.equal(validateCommand({ type: "prompt", commandId: "image", expectedGeneration: 1, message: "", images: [image] }).ok, true);
  assert.equal(validateCommand({ type: "prompt", commandId: "file", expectedGeneration: 1, message: "", files: [file] }).ok, true);
  assert.equal(validateCommand({ type: "prompt", commandId: "file", expectedGeneration: 1, message: "", files: [{ ...file, text: "" }] }).ok, false);
  assert.equal(validateCommand({ type: "prompt", commandId: "file", expectedGeneration: 1, message: "", files: [{ ...file, size: 8 }] }).ok, false);
  assert.equal(validateCommand({ type: "queuePrompt", commandId: "queue", expectedGeneration: 1, message: "next", images: [image], planMode: true }).ok, true);
  assert.equal(validateCommand({ type: "queuePrompt", commandId: "queue", expectedGeneration: 1, message: "next", planMode: "yes" }).ok, false);
  assert.equal(validateCommand({ type: "restoreQueuedPrompt", queueId: "queue-1", commandId: "restore", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "steerQueuedPrompt", queueId: "", commandId: "steer", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "prompt", commandId: "image", expectedGeneration: 1, message: "", images: [{ ...image, mimeType: "image/svg+xml" }] }).ok, false);
  assert.equal(validateCommand({ type: "prompt", commandId: "image", expectedGeneration: 1, message: "", images: Array(5).fill(image) }).ok, false);
});

test("embedded Helios browser validation allowlists bounded direct controls", () => {
  assert.ok(validateHeliosBrowserCommand({ action: "status", expectedGeneration: 1 }));
  assert.ok(validateHeliosBrowserCommand({ action: "start", expectedGeneration: 1, url: "https://example.com", width: 900, height: 650 }));
  assert.ok(validateHeliosBrowserCommand({ action: "pointer", expectedGeneration: 1, x: 10, y: 20, phase: "down", button: "left" }));
  assert.ok(validateHeliosBrowserCommand({ action: "key", expectedGeneration: 1, phase: "down", key: "Shift" }));
  assert.equal(validateHeliosBrowserCommand({ action: "status", expectedGeneration: 1, url: "https://unexpected.test" }), undefined);
  assert.equal(validateHeliosBrowserCommand({ action: "resize", expectedGeneration: 1, width: 319, height: 650 }), undefined);
  assert.equal(validateHeliosBrowserCommand({ action: "pointer", expectedGeneration: 1, x: -1, y: 20, phase: "move" }), undefined);
  assert.equal(validateHeliosBrowserCommand({ action: "key", expectedGeneration: 1, phase: "down", key: "bad\nkey" }), undefined);
  assert.equal(validateHeliosBrowserCommand({ action: "tab-close", expectedGeneration: 1, tabIndex: 101 }), undefined);
});

test("event and snapshot validators reject incompatible versions", () => {
  const event = {
    protocolVersion: PROTOCOL_VERSION,
    payloadVersion: 1,
    eventId: "event-1",
    sessionId: "session-1",
    sessionGeneration: 1,
    sequence: 0,
    occurredAt: new Date().toISOString(),
    type: "session.ready",
    payload: {},
  };
  assert.equal(isWebEvent(event), true);
  assert.equal(isWebEvent({ ...event, protocolVersion: PROTOCOL_VERSION + 1 }), false);
  assert.equal(isWebEvent({ ...event, sequence: -1 }), false);

  const snapshot = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "session-1",
    sessionGeneration: 1,
    ready: true,
    cwdLabel: "repo",
    activeTools: ["read"],
    availableTools: ["read", "verify"],
    optionalCapabilities: { verify: "available" },
    diagnostics: [],
    conversation: {
      messages: [], tools: [], delegatedRuns: [], streaming: false,
      queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false },
    },
    sessionControls: {
      model: { provider: "provider", id: "model", name: "Model" },
      models: [{ provider: "provider", id: "model", name: "Model", thinkingLevels: ["off", "high"] }],
      thinkingLevel: "high",
      thinkingLevels: ["low", "medium", "high"],
    },
    runtimePolicy: {
      revision: 1,
      global: { timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 },
      project: { verify: { mode: "auto" }, timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 },
      session: {},
      effective: { verify: { mode: "auto" }, timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 },
      availableVerifyChecks: [],
    },
    metrics: {
      model: "model", provider: "provider", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      contextTokens: 0, contextLimit: 0, contextPercent: 0, cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0,
    },
    operational: {
      verification: { availability: "available", checks: [] }, jobs: { availability: "unavailable", items: [] },
      guard: { availability: "available", blocked: 0, confirmed: 0 }, continuity: { availability: "available", revision: 0 },
      timeline: { availability: "available", revision: 0, checkpoints: [] }, tools: { availability: "available", policies: [] },
      sieve: { availability: "unavailable" },
      health: { status: "degraded", issues: ["jobs unavailable"] },
    },
    extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
  };
  assert.equal(isRuntimeSnapshot(snapshot), true);
  assert.equal(runtimeSnapshotValidationIssue(snapshot), undefined);
  assert.equal(isRuntimeSnapshot({
    ...snapshot,
    conversation: { ...snapshot.conversation, agentError: "provider rejected request" },
  }), true);
  assert.equal(isRuntimeSnapshot({
    ...snapshot,
    conversation: { ...snapshot.conversation, agentError: "x".repeat(1_001) },
  }), false);
  const expandedLatestTurn = [
    { id: "latest-user", role: "user", text: "Run every check", streaming: false },
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `latest-tool-${index}`,
      role: "tool",
      text: `result ${index}`,
      streaming: false,
    })),
  ];
  assert.equal(isRuntimeSnapshot({
    ...snapshot,
    conversation: { ...snapshot.conversation, messages: expandedLatestTurn },
  }), true);
  assert.equal(runtimeSnapshotValidationIssue({
    ...snapshot,
    conversation: { ...snapshot.conversation, messages: expandedLatestTurn },
  }), undefined);
  assert.deepEqual(runtimeSnapshotValidationIssue({ ...snapshot, protocolVersion: PROTOCOL_VERSION + 1 }), {
    kind: "protocol",
    area: "protocol",
    detail: `expected ${PROTOCOL_VERSION}, received ${PROTOCOL_VERSION + 1}`,
  });
  const invalidConversation = { ...snapshot, conversation: { ...snapshot.conversation, messages: "invalid" } };
  assert.equal(runtimeSnapshotValidationIssue(invalidConversation)?.area, "conversation");
  assert.match(describeRuntimeSnapshotIssue(invalidConversation) ?? "", new RegExp(`session session-1, generation 1, ready true, protocol ${PROTOCOL_VERSION}`));
  assert.equal(isRuntimeSnapshot({
    ...snapshot,
    sessionControls: {
      ...snapshot.sessionControls,
      pending: {
        model: { provider: "provider", id: "next-model", name: "Next Model", thinkingLevels: ["off", "high"] },
        thinkingLevel: "high",
      },
    },
  }), true);
  assert.equal(isRuntimeSnapshot({
    ...snapshot,
    sessionControls: {
      ...snapshot.sessionControls,
      pending: {
        model: { provider: "provider", id: "next-model", name: "x".repeat(201) },
        thinkingLevel: "high",
      },
    },
  }), false);
  assert.equal(isRuntimeSnapshot({
    ...snapshot,
    conversation: {
      ...snapshot.conversation,
      queue: {
        steering: 0,
        followUp: 1,
        pending: { id: "queue-1", preview: "next", attachmentCount: 1, fileAttachmentCount: 1, planMode: true, state: "queued" },
      },
    },
  }), true);
  assert.equal(isRuntimeSnapshot({
    ...snapshot,
    conversation: {
      ...snapshot.conversation,
      queue: {
        steering: 0,
        followUp: 1,
        pending: { id: "queue-1", preview: "x".repeat(2_001), attachmentCount: 1, fileAttachmentCount: 1, planMode: true, state: "queued" },
      },
    },
  }), false);
  const timedSnapshot = {
    ...snapshot,
    projectAvailable: true,
    sessionName: "Live rename",
    gitBranch: "codex/session-ui",
    conversation: {
      ...snapshot.conversation,
      workStartedAt: new Date().toISOString(),
      messages: [{ id: "assistant-1", entryId: "entry-1", role: "assistant", text: "Done", streaming: false, workDurationMs: 1_234 }],
      delegatedRuns: [{
        id: "scout-1",
        kind: "repo_scout",
        turn: 1,
        request: "Map the repository",
        response: "Report",
        status: "completed",
        modelName: "Scout",
        thinkingLevel: "high",
        durationMs: 1_000,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01 },
        activity: [{ kind: "call", tool: "read", text: "{}" }, { kind: "result", tool: "read", text: "source" }],
      }],
    },
    discoverIndex: { state: "idle", files: 12, symbols: 34, indexedAt: new Date(0).toISOString() },
  };
  assert.equal(isRuntimeSnapshot(timedSnapshot), true);
  assert.equal(isRuntimeSnapshot({
    ...timedSnapshot,
    conversation: { ...timedSnapshot.conversation, historyCursor: "cursor", historyRemaining: 50 },
  }), true);
  assert.equal(isRuntimeSnapshot({
    ...timedSnapshot,
    conversation: { ...timedSnapshot.conversation, historyCursor: "cursor" },
  }), false);
  assert.equal(isRuntimeSnapshot({ ...timedSnapshot, projectAvailable: "yes" }), false);
  assert.equal(isRuntimeSnapshot({ ...timedSnapshot, sessionName: "x".repeat(201) }), false);
  assert.equal(isRuntimeSnapshot({ ...timedSnapshot, gitBranch: "x".repeat(201) }), false);
  assert.equal(isRuntimeSnapshot({ ...timedSnapshot, conversation: { ...timedSnapshot.conversation, workStartedAt: "invalid" } }), false);
  assert.equal(isRuntimeSnapshot({ ...timedSnapshot, conversation: { ...timedSnapshot.conversation, messages: [{ ...timedSnapshot.conversation.messages[0], workDurationMs: 8 * 24 * 60 * 60 * 1_000 }] } }), false);
  assert.equal(isRuntimeSnapshot({ ...timedSnapshot, conversation: { ...timedSnapshot.conversation, delegatedRuns: [{ ...timedSnapshot.conversation.delegatedRuns[0], kind: "unknown" }] } }), false);
  assert.equal(isRuntimeSnapshot({ ...timedSnapshot, conversation: { ...timedSnapshot.conversation, delegatedRuns: [{ ...timedSnapshot.conversation.delegatedRuns[0], activity: [{ kind: "result", tool: "read", text: "x".repeat(2_001) }] }] } }), false);
  assert.equal(isRuntimeSnapshot({ ...snapshot, optionalCapabilities: { verify: "maybe" } }), false);

  const session = { id: "session-1", projectId: "project-one", cwdLabel: "repo", createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString(), userMessageCount: 1, preview: "hello", active: true, pinned: false, runtimeState: "idle" };
  const sessions = { protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, activeSessions: [session], projects: [{ id: "project-one", label: "repo", cwd: "/projects/repo", totalCount: 1, sessions: [session] }] };
  assert.equal(isSessionListSnapshot(sessions), true);
  assert.equal(isSessionListSnapshot({ ...sessions, activeSessions: [{ ...session, workStartedAt: new Date(1).toISOString() }] }), true);
  assert.equal(isSessionListSnapshot({ ...sessions, activeSessions: [{ ...session, workStartedAt: "invalid" }] }), false);
  assert.equal(isSessionListSnapshot({ ...sessions, projects: [{ id: "project-empty", label: "empty", cwd: "/projects/empty", totalCount: 0, sessions: [] }] }), true);
  assert.equal(isSessionListSnapshot({ ...sessions, projects: [{ ...sessions.projects[0], cwd: "" }] }), false);
  assert.equal(isSessionListSnapshot({ ...sessions, projects: [{ ...sessions.projects[0], sessions: [{ ...sessions.projects[0].sessions[0], projectId: "" }] }] }), false);
  assert.equal(isSessionListSnapshot({ ...sessions, projects: [{ ...sessions.projects[0], sessions: [{ ...sessions.projects[0].sessions[0], preview: "x".repeat(501) }] }] }), false);
  const archived = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    projects: [{ id: "project-one", label: "repo", sessionCount: 1, archivedAt: new Date(0).toISOString() }],
    sessions: [{ ...session, active: false, runtimeState: "sleeping", archivedAt: new Date(0).toISOString() }],
    totalSessionCount: 1,
  };
  assert.equal(isArchiveListSnapshot(archived), true);
  assert.equal(isArchiveListSnapshot({ ...archived, projects: [{ ...archived.projects[0], archivedAt: "invalid" }] }), false);

  const packages = { protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, packages: [{ id: "pi-advisor", name: "pi-advisor", description: "Advisor", enabled: true, active: true, extensionCount: 1, settings: { kind: "advisor", mode: "session", thinking: "high" } }] };
  assert.equal(isPackageListSnapshot(packages), true);
  assert.equal(isPackageListSnapshot({ ...packages, packages: [{ ...packages.packages[0], id: "" }] }), false);
  assert.equal(isPackageListSnapshot({ ...packages, packages: [{ ...packages.packages[0], extensionCount: 0 }] }), false);

  const history = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "session-1",
    sessionGeneration: 1,
    messages: [{ id: "history-1", entryId: "entry-1", role: "user", text: "Earlier", streaming: false }],
    remaining: 10,
    nextCursor: "cursor",
  };
  assert.equal(isConversationHistoryPage(history), true);
  assert.equal(isConversationHistoryPage({ ...history, messages: [{ ...history.messages[0], entryId: "" }] }), false);
  assert.equal(isConversationHistoryPage({ ...history, messages: Array(101).fill(history.messages[0]) }), false);
  assert.equal(isConversationHistoryPage({ ...history, remaining: -1 }), false);
});

test("conversation turn index validation keeps metadata bounded", () => {
  const page = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "session-one",
    sessionGeneration: 1,
    turns: [{ promptId: "prompt-one", preview: "Review the change", cursor: "aDox", createdAt: "2026-07-27T01:02:00.000Z" }],
    totalCount: 3,
  };
  assert.equal(isConversationTurnIndexPage(page), true);
  assert.equal(isConversationTurnIndexPage({ ...page, turns: [{ ...page.turns[0], preview: "x".repeat(121) }] }), false);
  assert.equal(isConversationTurnIndexPage({ ...page, turns: Array(251).fill(page.turns[0]) }), false);
});

test("StateQL snapshot validation bounds safe session status and history", () => {
  const entry = {
    command_id: "cmd_1",
    timestamp: "2026-07-30T10:00:00.000Z",
    session_id: "s_1",
    actor_id: "pi-session",
    command: "query",
    handle: "q_1",
    executed: true,
    cached: false,
    success: true,
    error_code: null,
  };
  const snapshot = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    session: { session_id: "s_1", name: "shared-workspace", status: "active" },
    actor_id: "pi-session",
    connection: { connection_id: "conn_1", name: "local", status: "connected", driver: "sqlite", database: "app.sqlite", read_only: true },
    transaction: { transaction_id: "tx_1", owner_actor_id: "pi-session", state: "active" },
    state_version: "sv_1",
    state_confidence: "database_reported",
    recent_results: [{ alias: "users", handle: "q_1", rows: 3 }],
    recent_operations: [{ handle: "op_1", actor_id: "pi-session", type: "insert", affected_rows: 1, status: "committed" }],
    history: [entry],
  };
  assert.equal(isStateQLSnapshot(snapshot), true);
  assert.equal(isStateQLSnapshot({ ...snapshot, actor_id: undefined }), false);
  assert.equal(isStateQLSnapshot({ ...snapshot, history: Array(101).fill(entry) }), false);
  assert.equal(isStateQLSnapshot({ ...snapshot, history: [{ ...entry, timestamp: "invalid" }] }), false);
  assert.equal(isStateQLSnapshot({ ...snapshot, history: [{ ...entry, timestamp: `${entry.timestamp}${"0".repeat(65)}` }] }), false);
  assert.equal(isStateQLSnapshot({ ...snapshot, recent_results: [{ ...snapshot.recent_results[0], rows: 10_001 }] }), false);
  assert.equal(isStateQLSnapshot({ ...snapshot, session: { ...snapshot.session, status: "closed" } }), false);
  assert.equal(isStateQLSnapshot({ ...snapshot, session: { ...snapshot.session, status: "closed" }, connection: null, transaction: null }), true);
});

test("file suggestion validation confines bounded relative paths", () => {
  const suggestions = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    available: true,
    paths: ["src/index.ts", "docs/with space.md"],
  };
  assert.equal(isFileSuggestionList(suggestions), true);
  assert.equal(isFileSuggestionList({ ...suggestions, paths: ["../secret"] }), false);
  assert.equal(isFileSuggestionList({ ...suggestions, paths: ["C:/secret.txt"] }), false);
  assert.equal(isFileSuggestionList({ ...suggestions, paths: Array(21).fill("src/index.ts") }), false);
});

test("workspace file validation confines paths and payloads", () => {
  const page = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    revision: "revision",
    files: [{ path: "src/index.ts", status: "modified", additions: 2, deletions: 1 }],
    totalCount: 1,
    truncated: false,
  };
  assert.equal(isWorkspaceFilePage(page), true);
  assert.equal(isWorkspaceFilePage({ ...page, files: [{ path: "../secret" }] }), false);
  assert.equal(isWorkspaceFilePage({ ...page, files: Array(201).fill(page.files[0]) }), false);

  const content = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    revision: "revision",
    path: "src/index.ts",
    state: "available",
    text: "export {};",
  };
  assert.equal(isWorkspaceFileContent(content), true);
  assert.equal(isWorkspaceFileContent({ ...content, path: "C:/secret" }), false);
  assert.equal(isWorkspaceFileContent({ ...content, text: "x".repeat(2 * 1024 * 1024 + 1) }), false);
});
