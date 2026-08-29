import test from "node:test";
import assert from "node:assert/strict";
import { fresh, isWork, setPlan } from "../src/active-work.ts";

test("plan revisions reject duplicate normalized todo text without mutating Work", () => {
  const work = fresh("Ship");
  setPlan(work, ["Implement"]);
  const before = structuredClone(work.todos);

  assert.throws(() => setPlan(work, ["Same step", " same   STEP "]), /unique non-empty text/);
  assert.deepEqual(work.todos, before);
  assert.equal(isWork(work), true);
});

test("initial plans ignore caller-supplied todo IDs", () => {
  const work = fresh("Ship");
  setPlan(work, [
    { id: "invented", text: "Implement" },
    { id: "invented", text: "Review" },
  ]);

  assert.deepEqual(
    work.todos.map(({ id, text }) => ({ id, text })),
    [
      { id: "todo_1", text: "Implement" },
      { id: "todo_2", text: "Review" },
    ],
  );
});

test("explicit todo IDs preserve progress across wording changes", () => {
  const work = fresh("Ship");
  setPlan(work, ["Implement", "Review"]);
  work.todos[0]!.status = "done";
  const implementId = work.todos[0]!.id;
  const reviewId = work.todos[1]!.id;

  setPlan(work, [
    { id: implementId, text: "Implement the approved change" },
    { id: reviewId, text: "Review" },
  ]);

  assert.deepEqual(
    work.todos.map(({ id, status }) => ({ id, status })),
    [
      { id: implementId, status: "done" },
      { id: reviewId, status: "pending" },
    ],
  );
  assert.throws(() => setPlan(work, [{ id: "todo_missing", text: "Unknown" }]), /IDs from the current plan/);
  assert.throws(
    () =>
      setPlan(work, [
        { id: implementId, text: "Implement" },
        { id: implementId, text: "Review" },
      ]),
    /IDs from the current plan/,
  );
  assert.equal(isWork(work), true);
});

test("plan revisions reject oversized lists before mutation", () => {
  const work = fresh("Ship");
  setPlan(work, ["Implement"]);
  const before = structuredClone(work.todos);

  assert.throws(
    () =>
      setPlan(
        work,
        Array.from({ length: 13 }, (_, index) => `Step ${index}`),
      ),
    /more than 12/,
  );
  assert.deepEqual(work.todos, before);
});

test("structured handoff and approval transition are validated", () => {
  const work = fresh("Ship");
  setPlan(work, ["Implement"]);
  work.planRevision = 1;
  work.handoff = {
    workingSet: ["src/index.ts"],
    assumptions: ["The public API remains stable."],
    acceptanceCriteria: ["Focused tests pass."],
  };
  work.approval = {
    token: "approval-token",
    revision: 1,
    resetContext: true,
    executorModel: { provider: "provider", id: "executor" },
    createdAt: new Date().toISOString(),
  };
  assert.equal(isWork(work), true);

  work.approval.revision = 2;
  assert.equal(isWork(work), false);
});
