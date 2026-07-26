import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import { isPackageListSnapshot, isRuntimeSnapshot, isSessionListSnapshot, isWebEvent, validateCommand } from "../src/shared/protocol/validation.ts";

test("command validation allowlists bounded v2 commands and images", () => {
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
  assert.equal(validateCommand({ type: "setModel", provider: "openai", modelId: "gpt-5", commandId: "model", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setModel", provider: "", modelId: "gpt-5", commandId: "model", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "setThinkingLevel", level: "high", commandId: "thinking", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "setThinkingLevel", level: "extreme", commandId: "thinking", expectedGeneration: 1 }).ok, false);
  assert.equal(validateCommand({ type: "deleteSession", sessionId: "session-1", commandId: "delete", expectedGeneration: 1 }).ok, true);
  assert.equal(validateCommand({ type: "deleteSession", sessionId: "", commandId: "delete", expectedGeneration: 1 }).ok, false);
  const image = { mimeType: "image/png", data: Buffer.from("image").toString("base64") };
  assert.equal(validateCommand({ type: "prompt", commandId: "image", expectedGeneration: 1, message: "", images: [image] }).ok, true);
  assert.equal(validateCommand({ type: "prompt", commandId: "image", expectedGeneration: 1, message: "", images: [{ ...image, mimeType: "image/svg+xml" }] }).ok, false);
  assert.equal(validateCommand({ type: "prompt", commandId: "image", expectedGeneration: 1, message: "", images: Array(5).fill(image) }).ok, false);
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
      messages: [], tools: [], streaming: false,
      queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false },
    },
    sessionControls: {
      model: { provider: "provider", id: "model", name: "Model" },
      models: [{ provider: "provider", id: "model", name: "Model" }],
      thinkingLevel: "high",
      thinkingLevels: ["low", "medium", "high"],
    },
    metrics: {
      model: "model", provider: "provider", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      contextTokens: 0, contextLimit: 0, contextPercent: 0, cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0,
    },
    operational: {
      verification: { availability: "available", checks: [] }, jobs: { availability: "unavailable", items: [] },
      guard: { availability: "available", blocked: 0, confirmed: 0 }, continuity: { availability: "available", revision: 0 },
      timeline: { availability: "available", revision: 0, checkpoints: [] }, tools: { availability: "available", policies: [] },
      health: { status: "degraded", issues: ["jobs unavailable"] },
    },
    extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
  };
  assert.equal(isRuntimeSnapshot(snapshot), true);
  assert.equal(isRuntimeSnapshot({ ...snapshot, optionalCapabilities: { verify: "maybe" } }), false);

  const sessions = { protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, projects: [{ id: "project-one", label: "repo", totalCount: 1, sessions: [{ id: "session-1", projectId: "project-one", cwdLabel: "repo", createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString(), userMessageCount: 1, preview: "hello", active: true, runtimeState: "idle" }] }] };
  assert.equal(isSessionListSnapshot(sessions), true);
  assert.equal(isSessionListSnapshot({ ...sessions, projects: [{ ...sessions.projects[0], sessions: [{ ...sessions.projects[0].sessions[0], projectId: "" }] }] }), false);
  assert.equal(isSessionListSnapshot({ ...sessions, projects: [{ ...sessions.projects[0], sessions: [{ ...sessions.projects[0].sessions[0], preview: "x".repeat(501) }] }] }), false);

  const packages = { protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, packages: [{ id: "pi-verify", name: "pi-verify", description: "Verification", enabled: true, active: true, extensionCount: 1 }] };
  assert.equal(isPackageListSnapshot(packages), true);
  assert.equal(isPackageListSnapshot({ ...packages, packages: [{ ...packages.packages[0], id: "" }] }), false);
  assert.equal(isPackageListSnapshot({ ...packages, packages: [{ ...packages.packages[0], extensionCount: 0 }] }), false);
});
