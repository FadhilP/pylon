import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildCompactionReviewPacket,
  callCompactionReviewer,
  validateCompactionReview,
} from "../src/compaction-review.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sources = [
  {
    sourceEntryId: "user-1",
    role: "user" as const,
    content: "Keep compatibility with old sessions.",
    sourceHash: hash("Keep compatibility with old sessions."),
  },
  {
    sourceEntryId: "assistant-1",
    role: "assistant" as const,
    content: "Decision: use exact source quotes.",
    sourceHash: hash("Decision: use exact source quotes."),
  },
  {
    sourceEntryId: "tool-1",
    role: "tool" as const,
    content: "provider unavailable",
    sourceHash: hash("provider unavailable"),
    isError: true,
  },
];
const packet = () =>
  buildCompactionReviewPacket({
    canonicalSummary: "Canonical deterministic state",
    sources,
  })!;
const output = (candidates: unknown[]) =>
  JSON.stringify({ version: 1, candidates });
const candidate = (overrides: Record<string, unknown> = {}) => ({
  sourceEntryId: "user-1",
  role: "user",
  category: "constraint",
  exactQuote: "Keep compatibility",
  ...overrides,
});
const response = (text: string, stopReason = "stop") => ({
  stopReason,
  content: [{ type: "text", text }],
  usage: {},
});

test("review validation accepts only exact source-grounded excerpts", () => {
  const result = validateCompactionReview(
    output([candidate(), candidate()]),
    packet(),
  );
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.supplements, [
    {
      sourceEntryId: "user-1",
      role: "user",
      category: "constraint",
      quote: "Keep compatibility",
      sourceHash: sources[0]!.sourceHash,
      quoteHash: hash("Keep compatibility"),
    },
  ]);

  const alreadyCanonical = buildCompactionReviewPacket({
    canonicalSummary: "Keep compatibility",
    sources,
  })!;
  assert.deepEqual(
    validateCompactionReview(output([candidate()]), alreadyCanonical)
      .supplements,
    [],
  );
});

test("review validation rejects malformed, ungrounded, mismatched, and over-broad output", () => {
  for (const raw of [
    "not json",
    JSON.stringify({ version: 1, candidates: [], extra: true }),
    output(Array.from({ length: 7 }, () => candidate())),
    output([candidate({ sourceEntryId: "missing" })]),
    output([candidate({ exactQuote: "invented text" })]),
    output([candidate({ role: "assistant" })]),
    output([candidate({ category: "decision" })]),
    output([{ ...candidate(), extra: true }]),
  ])
    assert.throws(
      () => validateCompactionReview(raw, packet()),
      /malformed|invalid|grounded/,
    );
});

test("review packet redacts credentials before model access and remains bounded", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const source = {
    sourceEntryId: "secret",
    role: "user" as const,
    content: `Use ${secret}`,
    sourceHash: hash(`Use ${secret}`),
  };
  const built = buildCompactionReviewPacket({
    canonicalSummary: "safe",
    sources: [source],
    focus: `focus ${secret}`,
  })!;
  assert.doesNotMatch(JSON.stringify(built), new RegExp(secret));
  assert.match(JSON.stringify(built), /REDACTED CREDENTIAL/);

  const path = "platform/web/src/shared/protocol/helios-android-tooling.ts";
  const withPath = buildCompactionReviewPacket({
    canonicalSummary: `Read/search: ${path}`,
    safePaths: [path],
    sources: [source],
  })!;
  assert.match(
    withPath.canonicalSummary,
    new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(withPath.canonicalSummary, /REDACTED CREDENTIAL/);

  const opaque = `${"A".repeat(30)}/${"B".repeat(24)}0`;
  const strict = buildCompactionReviewPacket({
    canonicalSummary: `User prose: ${opaque}`,
    sources: [source],
  })!;
  assert.doesNotMatch(strict.canonicalSummary, new RegExp(opaque));
  assert.match(strict.canonicalSummary, /REDACTED CREDENTIAL/);
  const untrustedAllowlist = buildCompactionReviewPacket({
    canonicalSummary: `User prose: ${opaque}`,
    safePaths: ["A"],
    sources: [source],
  })!;
  assert.match(untrustedAllowlist.canonicalSummary, /REDACTED CREDENTIAL/);

  const many = Array.from({ length: 100 }, (_, index) => ({
    sourceEntryId: `s-${index}`,
    role: "assistant" as const,
    content: "word ".repeat(800),
    sourceHash: hash("word ".repeat(800)),
  }));
  const bounded = buildCompactionReviewPacket({
    canonicalSummary: "safe",
    sources: many,
  })!;
  assert.ok(JSON.stringify(bounded).length <= 48_000);
  assert.ok(bounded.sources.length < many.length);
});

test("review completion reports bounded telemetry and propagates parent abort", async () => {
  const reviewed = await callCompactionReviewer({
    model: { provider: "test", id: "reviewer" },
    auth: { apiKey: "safe" },
    profile: { model: "test/reviewer", thinking: "low" },
    packet: packet(),
    sessionId: "session",
    completeReview: (async () => response(output([candidate()]))) as any,
  });
  assert.equal(reviewed.supplements.length, 1);
  assert.equal(reviewed.telemetry.candidateCount, 1);
  assert.equal(reviewed.telemetry.acceptedCount, 1);

  const abort = new AbortController();
  abort.abort();
  let receivedAbort = false;
  await assert.rejects(
    callCompactionReviewer({
      model: { provider: "test", id: "reviewer" },
      auth: { apiKey: "safe" },
      profile: { model: "test/reviewer" },
      packet: packet(),
      sessionId: "session",
      signal: abort.signal,
      completeReview: (async (_model: any, _context: any, options: any) => {
        receivedAbort = options.signal.aborted;
        return response("", "aborted");
      }) as any,
    }),
    /aborted/,
  );
  assert.equal(receivedAbort, true);
});
