import test from "node:test";
import assert from "node:assert/strict";
import type { UsageRecord, UsageSessionSummary } from "../src/shared/protocol/snapshots.ts";
import {
  buildUsageSeries,
  filterUsageRecords,
  groupUsage,
  topUsageSessions,
  usageCsv,
  usageDayKeys,
  usageFacetOptions,
  type UsageFilters,
} from "../src/shared/usage-data.ts";

const filters = (project: string[] = [], provider: string[] = [], model: string[] = []): UsageFilters => ({
  project: new Set(project),
  provider: new Set(provider),
  model: new Set(model),
});

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  day: "2026-03-20",
  sessionId: "session-1",
  projectId: "project-1",
  projectLabel: "Project one",
  provider: "anthropic",
  model: "claude",
  agent: "main",
  calls: 1,
  input: 100,
  output: 20,
  cacheRead: 100,
  cacheWrite: 0,
  cost: 1,
  costKnown: true,
  costInput: 0.6,
  costOutput: 0.4,
  costEstimated: 0,
  ...overrides,
});

test("usage filtering and grouping keep project identity and distinct session counts", () => {
  const records = [
    record(),
    record({
      day: "2026-03-21",
      model: "claude-small",
      agent: "advisor",
      input: 50,
      cacheRead: 0,
      cost: 0.5,
      costKnown: false,
    }),
    record({ sessionId: "session-2", provider: "openai", input: 80, cacheRead: 0, cost: 2 }),
    record({ sessionId: "session-3", projectId: "project-2", projectLabel: "Project two", provider: "openai" }),
  ];
  const selected = filters([], ["anthropic"]);
  const scoped = filterUsageRecords(records, selected);
  const total = groupUsage(scoped)[0]!;

  assert.equal(scoped.length, 2);
  assert.equal(total.sessions, 1);
  assert.equal(total.input, 150);
  assert.equal(total.cache, 40);
  assert.equal(total.costKnown, false);

  const dimensions = usageFacetOptions(records, selected);
  assert.deepEqual(
    dimensions.project.map(option => [option.value, option.sessions]),
    [["project-1", 1]],
  );
  assert.deepEqual(
    dimensions.provider.map(option => [option.value, option.sessions]),
    [
      ["anthropic", 1],
      ["openai", 2],
    ],
  );
  assert.deepEqual(
    dimensions.model.map(option => option.value),
    ["claude", "claude-small"],
  );
});

test("usage series use real UTC day buckets and preserve zero-use days", () => {
  const records = [
    record({ day: "2026-03-20", input: 10, output: 2 }),
    record({ day: "2026-03-22", input: 30, output: 6 }),
  ];
  const days = usageDayKeys({ fromInclusive: "2026-03-20T12:00:00.000Z", toExclusive: "2026-03-23T12:00:00.000Z" });
  assert.deepEqual(days, ["2026-03-20", "2026-03-21", "2026-03-22", "2026-03-23"]);

  const paired = buildUsageSeries(records, days, "total", "none");
  assert.deepEqual(
    paired.map(series => series.label),
    ["Input", "Output"],
  );
  assert.deepEqual(paired[0]?.values, [10, 0, 30, 0]);
  assert.deepEqual(paired[1]?.values, [2, 0, 6, 0]);

  const split = buildUsageSeries(
    [...records, record({ day: "2026-03-21", provider: "openai", input: 5, output: 1 })],
    days,
    "input",
    "provider",
  );
  assert.deepEqual(
    split.map(series => [series.label, series.values]),
    [
      ["anthropic", [10, 0, 30, 0]],
      ["openai", [0, 5, 0, 0]],
    ],
  );
});

test("heavy sessions aggregate matching records and rank by the selected measure", () => {
  const records = [
    record({ sessionId: "session-1", model: "claude", agent: "main", output: 5 }),
    record({ sessionId: "session-1", model: "claude-small", agent: "advisor", output: 20 }),
    record({ sessionId: "session-2", output: 10, cost: 10 }),
  ];
  const sessions: UsageSessionSummary[] = [
    {
      id: "session-1",
      projectId: "project-1",
      projectLabel: "Project one",
      title: "First session",
      createdAt: "2026-03-20T00:00:00.000Z",
      modifiedAt: "2026-03-20T01:00:00.000Z",
      elapsedMs: 3_600_000,
    },
    {
      id: "session-2",
      projectId: "project-1",
      projectLabel: "Project one",
      title: "Second session",
      createdAt: "2026-03-20T00:00:00.000Z",
      modifiedAt: "2026-03-20T00:30:00.000Z",
      elapsedMs: 1_800_000,
    },
  ];

  const rows = topUsageSessions(records, sessions, "output");
  assert.deepEqual(
    rows.map(row => row.id),
    ["session-1", "session-2"],
  );
  assert.equal(rows[0]?.output, 25);
  assert.equal(rows[0]?.model, "claude-small");
  assert.equal(rows[0]?.agent, "Advisor");
  assert.equal(rows[0]?.elapsedMs, 3_600_000);
});

test("usage CSV exports filtered records with quoting and spreadsheet protection", () => {
  const csv = usageCsv([
    record({
      projectLabel: "=SUM(1,2)",
      provider: "open,ai",
      model: 'model"name\nnext',
      agent: "advisor",
      cacheRead: 50,
    }),
  ]);

  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.match(csv, /"open,ai"/);
  assert.match(csv, /"model""name\nnext"/);
  assert.match(csv, /Advisor/);
  assert.match(csv, /33\.33/);
  assert.equal(usageCsv([]).split("\n").length, 1);
});

test("cache reads, session counts and agent splits each measure in their own unit", () => {
  const records = [
    record({ agent: "main", cacheRead: 300 }),
    record({ day: "2026-03-21", sessionId: "session-2", agent: "scout", cacheRead: 100, cost: 2 }),
  ];
  const days = usageDayKeys({ fromInclusive: "2026-03-20T00:00:00.000Z", toExclusive: "2026-03-22T00:00:00.000Z" });

  const cached = buildUsageSeries(records, days, "cacheRead", "none");
  assert.deepEqual(cached[0]?.values, [300, 100]);

  // Sessions are counted, not summed: two records of one session are one session.
  const sameSession = [record(), record({ model: "claude-small" })];
  const counted = buildUsageSeries(sameSession, days, "sessions", "none");
  assert.deepEqual(counted[0]?.values, [1, 0]);

  // A break-down draws one line per bucket, including agents, which are not a facet.
  const byAgent = buildUsageSeries(records, days, "cost", "agent");
  assert.deepEqual(
    byAgent.map(series => [series.label, series.kind, series.values]),
    [
      ["Scout", "agent", [0, 2]],
      ["Main agent", "agent", [1, 0]],
    ],
  );

  // Only combined input + output draws as an input/output pair.
  assert.deepEqual(
    buildUsageSeries(records, days, "total", "provider").map(series => series.label),
    ["anthropic"],
  );
});

test("combined cost draws its parts, and names what the provider never split", () => {
  const days = usageDayKeys({ fromInclusive: "2026-03-20T00:00:00.000Z", toExclusive: "2026-03-21T00:00:00.000Z" });

  const split = buildUsageSeries([record()], days, "cost", "none");
  assert.deepEqual(
    split.map(series => [series.label, series.part, series.amount]),
    [
      ["Input", "input", 0.6],
      ["Output", "output", 0.4],
    ],
  );

  // A delegated turn bills a total with no halves. The parts still add up to
  // the total, because the remainder is a part of its own.
  const mixed = buildUsageSeries(
    [record(), record({ sessionId: "session-2", cost: 1, costInput: 0, costOutput: 0 })],
    days,
    "cost",
    "none",
  );
  const close = (value: number | undefined, expected: number) => Math.abs((value ?? NaN) - expected) < 1e-9;
  assert.deepEqual(
    mixed.map(series => series.label),
    ["Input", "Output", "Not split"],
  );
  assert.ok(close(mixed[2]?.amount, 1));
  assert.ok(close(mixed[2]?.values[0], 1));
  assert.ok(
    close(
      mixed.reduce((total, series) => total + series.amount, 0),
      2,
    ),
  );

  // Nothing reported a split, so cost stays one line.
  const whole = buildUsageSeries([record({ costInput: 0, costOutput: 0 })], days, "cost", "none");
  assert.deepEqual(
    whole.map(series => series.label),
    ["Total"],
  );
});
