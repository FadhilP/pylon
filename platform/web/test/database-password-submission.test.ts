import assert from "node:assert/strict";
import test from "node:test";
import { databasePasswordSubmission } from "../src/client/database/database-password-submission.ts";
import type { UiRequestReadModel } from "../src/shared/protocol/events.ts";

const input = {
  target: "postgresql://dbuser@DB.EXAMPLE.COM.:5432/app%20db?sslmode=require",
  operationId: "setup-1",
  generation: 3,
  readOnly: true,
};
const request = (): UiRequestReadModel => ({
  requestId: "password-1",
  method: "input",
  surface: "database",
  operationId: input.operationId,
  owned: true,
  ownershipAvailable: false,
  payload: {
    context: "stateql-credential",
    credentialKind: "password",
    sessionGeneration: 3,
    inputType: "password",
    access: "read",
    driver: "postgres",
    username: "dbuser",
    hostname: "db.example.com",
    port: 5432,
    database: "app%20db",
  },
});

test("form passwords answer only the matching owned operation, generation, kind, destination and access", async () => {
  const submission = databasePasswordSubmission("p%@:/# Ü", input);
  const base = request();
  const wrong: UiRequestReadModel[] = [
    { ...base, operationId: "other" },
    { ...base, surface: undefined },
    { ...base, method: "confirm" },
    { ...base, owned: false },
    { ...base, expiresAt: new Date(0).toISOString() },
    ...Object.entries({
      sessionGeneration: 4,
      context: "provider-auth",
      credentialKind: "source",
      inputType: "text",
      access: "write",
      driver: "mysql",
      username: "other",
      hostname: "other.example.com",
      port: 5433,
      database: "other",
    }).map(([key, value]) => ({ ...base, payload: { ...base.payload, [key]: value } })),
  ];
  const sent: string[] = [];
  const send = async (_request: UiRequestReadModel, body: { value: string }) => {
    sent.push(body.value);
  };
  for (const pending of wrong) {
    assert.equal(submission.matches(pending), false);
    assert.equal(await submission.answer(pending, send), false);
  }
  assert.deepEqual(sent, []);
  assert.equal(await submission.answer(base, send), true);
  assert.deepEqual(sent, ["p%@:/# Ü"]);
  assert.equal(await submission.answer(base, send), false);
  assert.equal(submission.matches({ ...base, requestId: "password-2" }), false);
});

test("password submissions are one-shot across concurrent answers, cancellation and transport failure", async () => {
  const pending = request();
  let calls = 0;
  const send = async () => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
  };
  const submission = databasePasswordSubmission("sentinel", input);
  assert.deepEqual(await Promise.all([submission.answer(pending, send), submission.answer(pending, send)]), [
    true,
    false,
  ]);
  assert.equal(calls, 1);
  const cancelled = databasePasswordSubmission("sentinel", input);
  cancelled.clear();
  assert.equal(await cancelled.answer(pending, send), false);
  const failed = databasePasswordSubmission("sentinel", input);
  await assert.rejects(
    failed.answer(pending, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(await failed.answer(pending, send), false);
  assert.equal(calls, 1);
});

test("an answered password stays consumed across deadline expiry and renewal, but never authorizes another response", async () => {
  const submission = databasePasswordSubmission("sentinel", input);
  const pending = { ...request(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let responses = 0;
  const send = async () => {
    responses++;
  };
  await submission.answer(pending, send);
  const expired = { ...pending, expiresAt: new Date(0).toISOString() };
  for (const update of [expired, pending, expired]) {
    assert.equal(submission.matches(update), true);
    assert.equal(await submission.answer(update, send), false);
  }
  assert.equal(responses, 1);
  assert.equal(submission.matches({ ...expired, owned: false }), false);
  assert.equal(submission.matches({ ...expired, requestId: "different-request" }), false);
  submission.clear();
  assert.equal(submission.matches(pending), false);
  const fresh = databasePasswordSubmission("sentinel", input);
  assert.equal(await fresh.answer(expired, send), false);
  assert.equal(responses, 1);
});

test("empty passwords remain explicit answers and Redis password-only endpoints bind to the default user", async () => {
  const submission = databasePasswordSubmission("", { ...input, target: "rediss://localhost/0" });
  const pending = request();
  pending.payload = {
    ...pending.payload,
    driver: "redis",
    username: "default",
    hostname: "localhost",
    port: 6379,
    database: "0",
  };
  let answer: string | undefined;
  assert.equal(
    await submission.answer(pending, async (_request, body) => {
      answer = body.value;
    }),
    true,
  );
  assert.equal(answer, "");
  for (const password of ["x".repeat(4097), "line\nbreak", "nul\u0000byte"])
    assert.throws(() => databasePasswordSubmission(password, input), /Password must/);
  assert.throws(
    () => databasePasswordSubmission("sentinel", { ...input, target: "postgres://localhost/app" }),
    /username/,
  );
});
