import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionSummaryCache } from "../src/server/pi/session-summary-cache.ts";
import type { ProjectRegistry } from "../src/server/pi/project-registry.ts";
import { SessionIndex } from "../src/server/pi/session-index.ts";
import {
  aggregateUsage,
  modelRateLookup,
  usageWindow,
  type UsageIndexedSession,
} from "../src/server/pi/usage-aggregation.ts";
import { UsageHistoryAccumulator } from "../src/server/pi/usage-history.ts";
import { isUsageSnapshot } from "../src/shared/protocol/validation.ts";

const at = "2026-03-20T12:00:00.000Z";

const assistantEntry = (
  sessionEntryId: string,
  options: { provider?: string; model?: string; cost?: number; timestamp?: string } = {},
) => ({
  type: "message",
  id: sessionEntryId,
  parentId: null,
  timestamp: options.timestamp ?? at,
  message: {
    role: "assistant",
    provider: options.provider,
    model: options.model,
    responseModel: options.model ? `${options.model}-response` : undefined,
    timestamp: Date.parse(options.timestamp ?? at),
    content: [{ type: "toolCall", id: `tool-${sessionEntryId}`, name: "advisor", arguments: {} }],
    usage: {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 4,
      ...(options.cost === undefined ? {} : { cost: { total: options.cost } }),
    },
  },
});

function session(id: string, path: string, created = "2026-03-19T12:00:00.000Z"): SessionInfo {
  return {
    id,
    path,
    cwd: `/work/${id}`,
    created: new Date(created),
    modified: new Date(at),
    messageCount: 2,
    firstMessage: `Work on ${id}`,
    allMessagesText: `Work on ${id}`,
  };
}

test("usage history normalizes every persisted billable source", () => {
  const history = new UsageHistoryAccumulator("session-1");
  history.accept(assistantEntry("assistant-1", { provider: "anthropic", model: "claude", cost: 1.25 }));
  history.accept({
    type: "message",
    id: "result-1",
    parentId: "assistant-1",
    timestamp: at,
    message: {
      role: "toolResult",
      toolCallId: "tool-assistant-1",
      toolName: "advisor",
      content: [{ type: "text", text: "done" }],
      isError: false,
      details: {
        advisorModel: "openai/gpt-worker",
        turns: 2,
        usage: { input: 40, output: 10, cacheRead: 5, cacheWrite: 1, cost: 0.4 },
      },
    },
  });
  history.accept({
    type: "message",
    id: "spawn-result-1",
    parentId: "result-1",
    timestamp: at,
    message: {
      role: "toolResult",
      toolCallId: "spawn-call-1",
      toolName: "spawn_agent",
      content: [{ type: "text", text: "done" }],
      isError: false,
      details: {
        model: "google/gemini-worker",
        turns: 3,
        usage: { input: 30, output: 8, cacheRead: 4, cacheWrite: 0, cost: 0.2 },
      },
    },
  });
  history.accept({
    type: "compaction",
    id: "compact-1",
    parentId: "result-1",
    timestamp: at,
    usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } },
  });
  history.accept({
    type: "branch_summary",
    id: "summary-1",
    parentId: "compact-1",
    timestamp: at,
    usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } },
  });
  history.accept({
    type: "custom",
    id: "telemetry-entry",
    parentId: "summary-1",
    timestamp: at,
    customType: "pylon-telemetry",
    data: {
      version: 1,
      eventId: "timeline-call-1",
      package: "pi-timeline",
      kind: "model_call",
      status: "completed",
      durationMs: 25,
      usage: { turns: 1, input: 7, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.01 },
      context: { request: { characters: 10, hash: "a".repeat(64) }, result: { characters: 5, hash: "b".repeat(64) } },
    },
  });
  history.accept({
    type: "custom",
    id: "telemetry-entry-v2",
    parentId: "telemetry-entry",
    timestamp: at,
    customType: "pylon-telemetry",
    data: {
      version: 2,
      eventId: "timeline-call-2",
      package: "pi-timeline",
      kind: "model_call",
      provider: "openai",
      model: "gpt-title",
      status: "completed",
      durationMs: 25,
      usage: { turns: 1, input: 6, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.01 },
      context: { request: { characters: 10, hash: "c".repeat(64) }, result: { characters: 5, hash: "d".repeat(64) } },
    },
  });

  const result = history.result();
  assert.deepEqual(
    result.map(item => [item.source, item.agent]),
    [
      ["assistant", "main"],
      ["delegated", "advisor"],
      ["delegated", "private"],
      ["compaction", "main"],
      ["branch-summary", "main"],
      ["telemetry", "other"],
      ["telemetry", "other"],
    ],
  );
  assert.equal(result[0]?.model, "claude-response");
  assert.equal(result[1]?.calls, 2);
  assert.deepEqual([result[1]?.provider, result[1]?.model], ["openai", "gpt-worker"]);
  assert.deepEqual([result[2]?.provider, result[2]?.model], ["google", "gemini-worker"]);
  assert.equal(result[5]?.provider, "unknown");
  assert.deepEqual([result[6]?.provider, result[6]?.model], ["openai", "gpt-title"]);
  assert.ok(result.every(item => /^[a-f0-9]{64}$/.test(item.identity) && /^[a-f0-9]{64}$/.test(item.signature)));
});

test("ordinary spawned-session usage is not duplicated from its parent tool result", () => {
  const history = new UsageHistoryAccumulator("parent-session");
  history.accept({
    type: "message",
    id: "spawn-session-result",
    timestamp: at,
    message: {
      role: "toolResult",
      toolCallId: "spawn-session-call",
      toolName: "spawn_session",
      content: [],
      isError: false,
      details: {
        provider: "openai",
        modelId: "gpt-child",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
      },
    },
  });
  assert.deepEqual(history.result(), []);
});

test("usage aggregation deduplicates fork copies and isolates conflicting identities", () => {
  const first = new UsageHistoryAccumulator("session-1");
  first.accept(assistantEntry("copied-call", { provider: "anthropic", model: "claude", cost: 1 }));

  const fork = new UsageHistoryAccumulator("session-2");
  fork.accept(assistantEntry("copied-call", { provider: "anthropic", model: "claude", cost: 1 }));
  fork.accept(assistantEntry("new-call", { timestamp: "2026-03-21T12:00:00.000Z" }));

  const conflict = new UsageHistoryAccumulator("session-3");
  conflict.accept(assistantEntry("copied-call", { provider: "openai", model: "different", cost: 2 }));

  const indexed: UsageIndexedSession[] = [
    { session: session("session-2", "/sessions/fork.jsonl"), usage: fork.result() },
    { session: session("session-1", "/sessions/original.jsonl", "2026-03-18T12:00:00.000Z"), usage: first.result() },
    { session: session("session-3", "/sessions/conflict.jsonl"), usage: conflict.result() },
  ];
  const result = aggregateUsage(
    indexed,
    { days: 7 },
    4,
    (sessionId, cwd) => ({ id: `project-${sessionId}`, label: cwd.split("/").at(-1) ?? "Workspace" }),
    new Date("2026-03-22T12:00:00.000Z"),
  );

  assert.equal(result.records.length, 2);
  assert.equal(
    result.records.reduce((sum, row) => sum + row.input, 0),
    200,
  );
  assert.deepEqual(
    result.records.map(row => row.sessionId),
    ["session-1", "session-2"],
  );
  assert.equal(result.sessions.length, 2);
  assert.equal(result.diagnostics.conflictingDuplicates, 1);
  assert.equal(result.diagnostics.unknownCostRecords, 1);
  assert.equal(result.diagnostics.unknownAttributionRecords, 1);
  assert.equal(isUsageSnapshot(result), true);
});

test("custom usage bounds are UTC calendar days and end-exclusive on the following day", () => {
  const window = usageWindow({ from: "2026-03-15", through: "2026-03-16" }, new Date("2026-03-20T12:00:00Z"));
  assert.deepEqual(window, {
    fromInclusive: Date.parse("2026-03-15T00:00:00.000Z"),
    toExclusive: Date.parse("2026-03-17T00:00:00.000Z"),
  });
  for (const input of [
    { from: "2026-03-15", through: "2026-03-16", days: 7 as const },
    { from: "2026-03-16", through: "2026-03-15" },
    { from: "2026-03-15", through: "2026-03-15T00:00:00Z" },
    { from: "2026-03-15" },
    { from: "2026-06-20", through: "2026-06-20" },
    { from: "2025-01-01", through: "2026-03-20" },
  ])
    assert.throws(() => usageWindow(input, new Date("2026-03-20T12:00:00Z")));
});

test("usage ranges include their lower boundary and exclude the current-time boundary", () => {
  const history = new UsageHistoryAccumulator("session-range");
  history.accept(
    assistantEntry("range-start", {
      provider: "anthropic",
      model: "claude",
      cost: 0.1,
      timestamp: "2026-03-15T12:00:00.000Z",
    }),
  );
  history.accept(
    assistantEntry("range-end", {
      provider: "anthropic",
      model: "claude",
      cost: 0.1,
      timestamp: "2026-03-22T12:00:00.000Z",
    }),
  );
  const result = aggregateUsage(
    [{ session: session("session-range", "/sessions/range.jsonl"), usage: history.result() }],
    { days: 7 },
    1,
    () => ({ id: "project-range", label: "Range" }),
    new Date("2026-03-22T12:00:00.000Z"),
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.day, "2026-03-15");
});

test("session cache extracts usage while isolating malformed session files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-usage-cache-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const liveAt = new Date(Date.now() - 1_000).toISOString();
    const directory = join(root, "sessions", "project");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "good.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "session-good", timestamp: liveAt, cwd: "/work/good" }),
        "{ malformed",
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: liveAt,
          message: { role: "user", timestamp: Date.parse(liveAt), content: [{ type: "text", text: "Hello" }] },
        }),
        JSON.stringify(
          assistantEntry("assistant-good", { provider: "anthropic", model: "claude", cost: 0.5, timestamp: liveAt }),
        ),
      ].join("\n"),
    );
    await writeFile(join(directory, "bad.jsonl"), `${JSON.stringify({ type: "message", id: "no-header" })}\n`);

    const cache = new SessionSummaryCache(root);
    const indexed = await cache.scan();
    assert.equal(indexed.length, 1);
    assert.equal(cache.unreadableFileCount(), 1);
    assert.equal(indexed[0]?.session.id, "session-good");
    assert.equal(indexed[0]?.usage.length, 1);
    assert.equal(indexed[0]?.usage[0]?.cost, 0.5);

    const warm = await new SessionSummaryCache(root).scan();
    assert.equal(warm[0]?.usage[0]?.model, "claude-response");
    const registry = {
      listSessionWorkspaces: () => [{ sessionId: "session-good", projectId: "project-explicit" }],
      get: (id: string) =>
        id === "project-explicit" ? { id, label: "Explicit project", cwd: "/work/good" } : undefined,
    } as ProjectRegistry;
    const snapshot = await new SessionIndex(registry, root).usage(
      { days: 90 },
      { activeId: "session-good", generation: 3, stateFor: () => "sleeping" },
    );
    assert.equal(snapshot.sessionGeneration, 3);
    assert.equal(snapshot.diagnostics.unreadableFiles, 1);
    assert.equal(snapshot.records[0]?.projectId, "project-explicit");
    assert.equal(snapshot.records[0]?.projectLabel, "Explicit project");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("per-part cost is kept only when the halves reconcile with the total", () => {
  const priced = (cost: unknown) => ({
    type: "message",
    id: "assistant-priced",
    parentId: null,
    timestamp: at,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude",
      timestamp: Date.parse(at),
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, cost },
    },
  });

  // Cache work is prompt-side, so it joins the input half.
  const reported = new UsageHistoryAccumulator("session-1");
  reported.accept(priced({ input: 0.5, output: 0.4, cacheRead: 0.1, cacheWrite: 0, total: 1 }));
  const atom = reported.result()[0]!;
  assert.equal(atom.cost, 1);
  assert.deepEqual([atom.costInput, atom.costOutput], [0.6, 0.4]);

  // Halves that do not add up to the billed total are not a split worth showing.
  const drifting = new UsageHistoryAccumulator("session-2");
  drifting.accept(priced({ input: 0.2, output: 0.1, total: 1 }));
  const drifted = drifting.result()[0]!;
  assert.equal(drifted.cost, 1);
  assert.deepEqual([drifted.costInput, drifted.costOutput], [0, 0]);

  // A provider that reports only a total keeps reporting only a total.
  const totalOnly = new UsageHistoryAccumulator("session-3");
  totalOnly.accept(priced(0.75));
  const whole = totalOnly.result()[0]!;
  assert.deepEqual([whole.cost, whole.costInput, whole.costOutput], [0.75, 0, 0]);
});

test("a delegated turn splits its cost from the rates it reports beside the total", () => {
  const delegated = (usage: Record<string, unknown>) => ({
    type: "message",
    id: "result-delegated",
    parentId: null,
    timestamp: at,
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "advisor",
      timestamp: Date.parse(at),
      details: { model: "anthropic/claude", usage },
    },
  });

  // Subagents keep cost a scalar for their budgets and carry the parts beside it.
  const history = new UsageHistoryAccumulator("session-1");
  history.accept(
    delegated({
      input: 8071,
      output: 1154,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.075,
      costParts: { input: 0.04, output: 0.03, cacheRead: 0.005, cacheWrite: 0 },
    }),
  );
  const atom = history.result()[0]!;
  assert.equal(atom.cost, 0.075);
  assert.deepEqual([atom.costInput, atom.costOutput], [0.045, 0.03]);

  // A delegate that reports no parts still reports its total.
  const bare = new UsageHistoryAccumulator("session-2");
  bare.accept(delegated({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01 }));
  const whole = bare.result()[0]!;
  assert.deepEqual([whole.cost, whole.costInput, whole.costOutput], [0.01, 0, 0]);
});

test("a total logged without a split is divided by catalogue rates, and says so", () => {
  const delegated = new UsageHistoryAccumulator("session-1");
  delegated.accept({
    type: "message",
    id: "result-1",
    parentId: null,
    timestamp: at,
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "advisor",
      timestamp: Date.parse(at),
      // The shape every delegated turn had before it reported its parts.
      details: { model: "anthropic/claude", usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, cost: 1 } },
    },
  });
  const indexed: UsageIndexedSession[] = [
    { session: session("session-1", "/sessions/one.jsonl"), usage: delegated.result() },
  ];
  const project = (sessionId: string) => ({ id: `project-${sessionId}`, label: "Workspace" });
  const aggregate = (rates?: Parameters<typeof aggregateUsage>[6]) =>
    aggregateUsage(indexed, { days: 7 }, 1, project, new Date("2026-03-22T12:00:00.000Z"), 0, rates).records[0]!;

  // 900 prompt tokens at $3/Mtok and 100 completion at $15/Mtok is a 9:5 ratio.
  const split = aggregate(() => ({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }));
  assert.ok(Math.abs(split.costInput - 9 / 14) < 1e-9);
  assert.ok(Math.abs(split.costOutput - 5 / 14) < 1e-9);
  assert.equal(split.costEstimated, 1);
  // Whatever the rates, the parts add up to what was actually billed.
  assert.ok(Math.abs(split.costInput + split.costOutput - split.cost) < 1e-9);

  // Rates supply the ratio only: ten times the prices give the same split.
  const dearer = aggregate(() => ({ input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 }));
  assert.deepEqual([dearer.costInput, dearer.costOutput], [split.costInput, split.costOutput]);

  // A model the catalogue does not price keeps its total whole.
  const unpriced = aggregate(() => undefined);
  assert.deepEqual([unpriced.costInput, unpriced.costOutput, unpriced.costEstimated], [0, 0, 0]);

  // With no catalogue at all, nothing is derived.
  assert.equal(aggregate(undefined).costEstimated, 0);
});

test("catalogue rates resolve by reference, and by model id only when it is unambiguous", () => {
  const rates = modelRateLookup([
    { provider: "openai-codex", id: "gpt-5.6-sol", cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
    { provider: "anthropic", id: "shared", cost: { input: 3, output: 15 } },
    { provider: "bedrock", id: "shared", cost: { input: 3, output: 15 } },
    { provider: "anthropic", id: "unpriced", cost: { input: -1, output: 15 } },
  ]);

  assert.deepEqual(rates("openai-codex", "gpt-5.6-sol"), { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
  // Cache rates fall back to the input rate rather than to nothing.
  assert.deepEqual(rates("anthropic", "shared"), { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });

  // A naming turn logs the model without its provider.
  assert.equal(rates("unknown", "gpt-5.6-sol")?.output, 30);
  // Two providers offer "shared", so the id alone identifies nothing.
  assert.equal(rates("unknown", "shared"), undefined);
  // A placeholder rate is not a price.
  assert.equal(rates("anthropic", "unpriced"), undefined);
  // A wrong provider is not repaired by the id.
  assert.equal(rates("anthropic", "gpt-5.6-sol"), undefined);
});
