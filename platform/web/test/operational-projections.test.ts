import test from "node:test";
import assert from "node:assert/strict";
import { applyOperationalEvent, initialOperational } from "../src/server/pi/operational-projections.ts";

test("Verify running lifecycle exposes active checks before they finish", () => {
  const startedAt = new Date(1_000).toISOString();
  const checkStartedAt = new Date(2_000).toISOString();
  const state = applyOperationalEvent(initialOperational(["verify"], []), "pi-verify:lifecycle", {
    version: 1,
    state: "running",
    runId: "run-1",
    scope: "changed",
    startedAt,
    results: [],
    activeChecks: [{ id: "npm:test", label: "npm test", command: "npm test", startedAt: checkStartedAt }],
  });

  assert.equal(state.verification.availability, "available");
  assert.equal(state.verification.state, "running");
  assert.equal(state.verification.startedAt, startedAt);
  assert.equal(state.verification.scope, "changed");
  assert.deepEqual(state.verification.checks, [
    {
      id: "npm:test",
      label: "npm test",
      command: "npm test",
      status: "running",
      durationMs: 0,
      startedAt: checkStartedAt,
      truncated: false,
    },
  ]);
});

test("operational projections structurally share unchanged branches and ignore stale snapshots", () => {
  const initial = initialOperational(["heartbeat_start", "continuity_update"], []);
  const withJob = applyOperationalEvent(initial, "pi-heartbeat:job", {
    version: 1,
    id: "job-1",
    label: "Index",
    state: "running",
    startedAt: new Date(0).toISOString(),
  });
  assert.notStrictEqual(withJob.jobs, initial.jobs);
  assert.strictEqual(withJob.continuity, initial.continuity);
  assert.strictEqual(withJob.timeline, initial.timeline);
  assert.strictEqual(applyOperationalEvent(withJob, "unknown", {}), withJob);

  const continuity = applyOperationalEvent(
    withJob,
    "pi-continuity:state-change",
    {
      version: 4,
      revision: 1,
      sessionId: "session",
      available: true,
      memory: [],
      globalMemory: [],
      v4MigrationAvailable: true,
    },
    [],
    "session",
  );
  assert.equal(continuity.continuity.v4MigrationAvailable, true);
  assert.strictEqual(
    applyOperationalEvent(
      continuity,
      "pi-continuity:state-change",
      { version: 4, revision: 1, sessionId: "session", available: false, memory: [], globalMemory: [] },
      [],
      "session",
    ),
    continuity,
  );
});

test("papercut summaries are session scoped and reject stale revisions", () => {
  const initial = initialOperational([], []);
  const current = applyOperationalEvent(
    initial,
    "pi-papercut:state-change",
    {
      version: 1,
      sessionId: "session",
      available: true,
      revision: 1,
      counts: { open: 2, resolved: 1, dismissed: 0, total: 3 },
    },
    [],
    "session",
  );
  assert.equal(current.papercuts.availability, "available");
  assert.deepEqual(current.papercuts.counts, { open: 2, resolved: 1, dismissed: 0, total: 3 });
  assert.strictEqual(
    applyOperationalEvent(
      current,
      "pi-papercut:state-change",
      {
        version: 1,
        sessionId: "session",
        available: false,
        revision: 1,
        counts: { open: 0, resolved: 0, dismissed: 0, total: 0 },
      },
      [],
      "session",
    ),
    current,
  );
  assert.strictEqual(
    applyOperationalEvent(
      current,
      "pi-papercut:state-change",
      {
        version: 1,
        sessionId: "other",
        available: false,
        revision: 2,
        counts: { open: 0, resolved: 0, dismissed: 0, total: 0 },
      },
      [],
      "session",
    ),
    current,
  );
});

test("Memory V6 projections fail closed for missing, malformed, or cross-scope notes", () => {
  const initial = initialOperational(["continuity_update"], []);
  const missing = applyOperationalEvent(
    initial,
    "pi-continuity:state-change",
    { version: 4, revision: 1, sessionId: "s", available: true },
    [],
    "s",
  );
  assert.equal(missing.continuity.availability, "unavailable");
  assert.equal(initial.continuity.v4MigrationAvailable, false);
  const malformed = applyOperationalEvent(
    initial,
    "pi-continuity:state-change",
    {
      version: 4,
      revision: 2,
      sessionId: "s",
      available: true,
      memory: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          scope: "user",
          trigger: "x",
          guidance: "y",
          authority: "user_instruction",
          origin: "user",
          revision: 1,
          updatedAt: new Date(0).toISOString(),
          sourceSummary: "user",
        },
      ],
      globalMemory: [],
    },
    [],
    "s",
  );
  assert.equal(malformed.continuity.availability, "unavailable");
  const unsafePath = applyOperationalEvent(
    initial,
    "pi-continuity:state-change",
    {
      version: 4,
      revision: 3,
      sessionId: "s",
      available: true,
      memory: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          scope: "project",
          trigger: "x",
          guidance: "y",
          authority: "project_contract",
          origin: "agent",
          revision: 1,
          updatedAt: new Date(0).toISOString(),
          sourceSummary: "repo",
          relatedPaths: ["../secret"],
        },
      ],
      globalMemory: [],
    },
    [],
    "s",
  );
  assert.equal(unsafePath.continuity.availability, "unavailable");
});

test("operational projections bound package payloads and isolate malformed versions", () => {
  let state = initialOperational(
    ["verify", "heartbeat_start", "continuity_update"],
    ["pi-guard.ts", "pi-timeline.ts", "pylon-core.ts"],
  );
  state = applyOperationalEvent(state, "pi-verify:result", {
    version: 1,
    state: "failed",
    runId: "run",
    scope: "changed",
    startedAt: new Date().toISOString(),
    results: Array.from({ length: 30 }, (_, index) => ({
      id: `check-${index}`,
      label: `Check ${index}`,
      command: "npm test",
      code: 1,
      output: "x".repeat(10_000),
      durationMs: 50,
    })),
  });
  assert.equal(state.verification.availability, "available");
  assert.equal(state.verification.checks.length, 20);
  assert.ok(state.verification.checks.reduce((bytes, item) => bytes + (item.output?.length ?? 0), 0) <= 16 * 1024);

  state = applyOperationalEvent(state, "pi-heartbeat:job", { version: 99 });
  assert.equal(state.jobs.availability, "unavailable");
  assert.equal(state.verification.availability, "available");
  assert.equal(state.health.status, "degraded");
});

test("state snapshots reject stale revisions and policy unregister removes owner", () => {
  let state = initialOperational([], ["pylon-core.ts"]);
  state = applyOperationalEvent(
    state,
    "pi-continuity:state-change",
    {
      version: 4,
      revision: 2,
      sessionId: "session",
      available: true,
      memory: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          scope: "project",
          trigger: "Architecture",
          guidance: "Use the coordinator",
          authority: "project_contract",
          origin: "agent",
          revision: 1,
          updatedAt: new Date(0).toISOString(),
          sourceSummary: "test",
        },
      ],
      globalMemory: [
        {
          id: "00000000-0000-0000-0000-000000000002",
          scope: "user",
          trigger: "Preference",
          guidance: "Keep output concise",
          authority: "user_instruction",
          origin: "user",
          revision: 1,
          updatedAt: new Date(0).toISOString(),
          sourceSummary: "user",
        },
      ],
      work: {
        mode: "planning",
        goal: "Ship",
        approved: false,
        approvalPending: true,
        planSummary: "Implement",
        planRevision: 2,
        handoff: {
          workingSet: ["src/index.ts"],
          assumptions: ["API remains stable"],
          acceptanceCriteria: ["Tests pass"],
        },
        revisionFeedback: { revision: 1, text: "Clarify it", createdAt: new Date(0).toISOString() },
        createdAt: "now",
        updatedAt: "now",
        todos: [{ id: "todo_1", text: "Build", status: "in_progress", updatedAt: "now" }],
      },
    },
    [],
    "session",
  );
  state = applyOperationalEvent(
    state,
    "pi-continuity:state-change",
    { version: 4, revision: 2, sessionId: "session", available: false, memory: [], globalMemory: [] },
    [],
    "session",
  );
  state = applyOperationalEvent(
    state,
    "pi-continuity:state-change",
    { version: 4, revision: 3, sessionId: "old-session", available: false, memory: [], globalMemory: [] },
    [],
    "session",
  );
  assert.equal(state.continuity.revision, 2);
  assert.equal(state.continuity.work?.goal, "Ship");
  assert.equal(state.continuity.work?.approvalPending, true);
  assert.equal(state.continuity.work?.planRevision, 2);
  assert.deepEqual(state.continuity.work?.handoff?.workingSet, ["src/index.ts"]);
  assert.equal(state.continuity.work?.revisionFeedback?.text, "Clarify it");
  assert.equal(state.continuity.memory[0]?.trigger, "Architecture");
  assert.equal(state.continuity.globalMemory[0]?.trigger, "Preference");
  state = applyOperationalEvent(
    state,
    "pi-continuity:state-change",
    { version: 3, revision: 3, sessionId: "session", available: true, memory: [] },
    [],
    "session",
  );
  assert.equal(state.continuity.availability, "unavailable");
  assert.equal(state.continuity.globalMemory[0]?.trigger, "Preference");

  state = applyOperationalEvent(
    state,
    "pi-timeline:state-change",
    {
      version: 4,
      revision: 1,
      sessionId: "session",
      available: true,
      undoPromptEntryIds: ["user-2"],
      checkpoints: [
        {
          id: "checkpoint-1",
          promptEntryId: "user-1",
          title: "First prompt",
          ownerSessionId: "session",
          createdAt: new Date(0).toISOString(),
          verified: true,
        },
        {
          id: "checkpoint-2",
          promptEntryId: "user-2",
          title: "Failed prompt",
          ownerSessionId: "session",
          createdAt: new Date(1).toISOString(),
          verified: false,
          verificationState: "failed",
        },
      ],
      failures: [
        {
          id: "failure-1",
          promptEntryId: "user-3",
          title: "Third prompt",
          createdAt: new Date(2).toISOString(),
          reason: "Git operation in progress: .",
        },
        { id: "invalid failure" },
      ],
    },
    [],
    "session",
  );
  assert.equal(state.timeline.checkpoints[0]?.id, "checkpoint-1");
  assert.equal(state.timeline.checkpoints[0]?.promptEntryId, "user-1");
  assert.equal(state.timeline.checkpoints[0]?.verificationState, "passed");
  assert.equal(state.timeline.checkpoints[1]?.verificationState, "failed");
  assert.equal(state.timeline.checkpoints[1]?.verified, false);
  assert.deepEqual(state.timeline.failures, [
    {
      id: "failure-1",
      promptEntryId: "user-3",
      title: "Third prompt",
      createdAt: new Date(2).toISOString(),
      reason: "Git operation in progress: .",
    },
  ]);

  state = applyOperationalEvent(state, "pylon:tool-policy", {
    version: 1,
    kind: "register",
    owner: "pi-test",
    managedTools: ["test"],
    enabledTools: ["test"],
  });
  assert.equal(state.tools.policies.length, 1);
  state = applyOperationalEvent(state, "pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-test" });
  assert.equal(state.tools.policies.length, 0);
});

test("Sieve projections retain bounded per-tool telemetry", () => {
  const stats = {
    scanned: 2,
    transformed: 1,
    omittedChars: 1_000,
    netCharsSaved: 900,
    transformedBy: {
      ageThreshold: 0,
      budget: 0,
      activeThreshold: 0,
      staleRead: 0,
      duplicate: 1,
      errorCap: 0,
      mixedText: 0,
    },
    byTool: { read: { scanned: 2, transformed: 1, sourceChars: 2_000, retainedChars: 1_100, netCharsSaved: 900 } },
  };
  const payload = {
    version: 1,
    available: true,
    mode: "enabled",
    projectionMode: "stable",
    threshold: 8_192,
    activePruning: true,
    latestMode: "enabled",
    latest: stats,
    cumulativeActual: stats,
    cumulativeProjected: { ...stats, transformed: 0, byTool: {} },
    recalls: 1,
    recalledChars: 1_000,
    recallsByTool: { read: { recalls: 1, recalledChars: 1_000 } },
    epoch: {
      id: "epoch-1",
      reason: "prompt",
      startedAt: new Date(0).toISOString(),
      promptFingerprint: "fingerprint",
      frozenResultCount: 2,
      frozenSourceChars: 2_000,
      frozenRetainedChars: 1_100,
      rolloverEligibleRetainedChars: 900,
      recoverableEntries: 1,
    },
    stability: {
      newProjections: 1,
      projectionCacheHits: 2,
      recoverableEntries: 1,
      explicitReflows: 0,
      softBudgetExceedances: 0,
      prefixChurnViolations: 0,
      estimatedInvalidatedChars: 0,
    },
    contextUsagePercent: 42.5,
    updatedAt: new Date(0).toISOString(),
  };
  const state = applyOperationalEvent(initialOperational([], ["pi-sieve.ts"]), "pi-sieve:state-change", payload);

  assert.equal(state.sieve.availability, "available");
  assert.equal(state.sieve.cumulativeActual?.byTool.read?.netCharsSaved, 900);
  assert.deepEqual(state.sieve.recallsByTool?.read, { recalls: 1, recalledChars: 1_000 });
  assert.equal(state.sieve.projectionMode, "stable");
  assert.equal(state.sieve.epoch?.frozenRetainedChars, 1_100);
  assert.equal(state.sieve.epoch?.rolloverEligibleRetainedChars, 900);
  assert.equal(state.sieve.stability?.projectionCacheHits, 2);
  assert.equal(state.sieve.contextUsagePercent, 42.5);
  const invalid = applyOperationalEvent(state, "pi-sieve:state-change", {
    ...payload,
    stability: { ...payload.stability, projectionCacheHits: -1 },
  });
  assert.equal(invalid.sieve.availability, "unavailable");
});

test("Sieve standard-v2 projections expose bounded churn telemetry", () => {
  const stats = {
    scanned: 1,
    transformed: 1,
    omittedChars: 100,
    netCharsSaved: 100,
    transformedBy: {
      ageThreshold: 0,
      budget: 0,
      activeThreshold: 1,
      staleRead: 0,
      duplicate: 0,
      errorCap: 0,
      mixedText: 0,
    },
    byTool: {},
  };
  const changes = {
    activeThreshold: 1,
    ageThreshold: 2,
    budget: 3,
    staleRead: 4,
    duplicate: 5,
    errorCap: 6,
    history: 7,
  };
  const payload = {
    version: 1,
    available: true,
    mode: "enabled",
    projectionMode: "standard-v2",
    threshold: 8_192,
    activePruning: true,
    latestMode: "enabled",
    latest: stats,
    cumulativeActual: stats,
    cumulativeProjected: stats,
    recalls: 0,
    recalledChars: 0,
    recallsByTool: {},
    updatedAt: new Date(0).toISOString(),
    stability: {
      newProjections: 1,
      projectionCacheHits: 0,
      recoverableEntries: 0,
      explicitReflows: 0,
      softBudgetExceedances: 0,
      prefixChurnViolations: 0,
      estimatedInvalidatedChars: 0,
      standardComparisons: 12,
      standardPrefixChurn: 3,
      standardEarliestChangedPriorMessageIndex: 4,
      standardEstimatedInvalidatedChars: 9_000,
      standardChangesByKind: changes,
    },
  };
  const state = applyOperationalEvent(initialOperational([], ["pi-sieve.ts"]), "pi-sieve:state-change", payload);
  assert.equal(state.sieve.projectionMode, "standard-v2");
  assert.equal(state.sieve.stability?.standardComparisons, 12);
  assert.equal(state.sieve.stability?.standardPrefixChurn, 3);
  assert.equal(state.sieve.stability?.standardEarliestChangedPriorMessageIndex, 4);
  assert.equal(state.sieve.stability?.standardEstimatedInvalidatedChars, 9_000);
  assert.deepEqual(state.sieve.stability?.standardChangesByKind, changes);
  assert.equal(
    applyOperationalEvent(state, "pi-sieve:state-change", {
      ...payload,
      stability: { ...payload.stability, standardChangesByKind: { ...changes, history: -1 } },
    }).sieve.availability,
    "unavailable",
  );
});

test("Heartbeat accepts numeric timestamps and cancelling jobs", () => {
  let state = initialOperational([], ["pi-heartbeat.ts"]);
  state = applyOperationalEvent(state, "pi-heartbeat:job", {
    version: 1,
    id: "job-1",
    label: "Run checks",
    state: "cancelling",
    startedAt: 1_000,
    finishedAt: 2_000,
    purpose: "verification",
    exitCode: null,
  });

  assert.equal(state.jobs.availability, "available");
  assert.deepEqual(state.jobs.items[0], {
    id: "job-1",
    label: "Run checks",
    state: "cancelling",
    startedAt: new Date(1_000).toISOString(),
    finishedAt: new Date(2_000).toISOString(),
    exitCode: null,
    purpose: "verification",
  });
});

test("operational projections reject out-of-range timestamps without throwing", () => {
  const state = applyOperationalEvent(initialOperational([], ["pi-heartbeat.ts"]), "pi-heartbeat:job", {
    version: 1,
    id: "job-1",
    state: "running",
    startedAt: 1e100,
  });

  assert.deepEqual(state.jobs, { availability: "unavailable", items: [] });
});
