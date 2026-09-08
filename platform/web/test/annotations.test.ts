import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AnnotationStore } from "../src/server/workspace/annotation-store.ts";
import {
  AnnotationReads,
  persistAnnotation,
  validAnnotation,
  annotationRange,
  captureAnnotation,
  annotationPrompt,
  reviewAnnotations,
  sourceHash,
  MAX_ANNOTATIONS,
  type Annotation,
  type AnnotationList,
} from "../src/shared/workspace/annotations.ts";
import { selectedText } from "../src/shared/workspace/code-viewer-model.ts";

const note = (changes: Partial<Annotation> = {}): Annotation => ({
  id: randomUUID(),
  scope: JSON.stringify(["project", "session"]),
  version: 1,
  body: "Check this race.",
  path: "src/store.ts",
  from: 2,
  to: 3,
  code: "save();\nreturn;",
  kind: "historical",
  revision: "commit:123",
  ...changes,
});

test("drafts survive database restart and separate browsers, enforce CAS, scope, bounds and deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pylon-notes-"));
  const path = join(dir, "notes.sqlite");
  let first: AnnotationStore | undefined;
  let second: AnnotationStore | undefined;
  const put = (db: AnnotationStore, n: Annotation, expectedVersion?: number) =>
    db.mutate("project", "session", {
      sessionId: "session",
      expectedGeneration: 1,
      id: n.id,
      expectedVersion,
      note: n,
    });
  try {
    first = new AnnotationStore(path);
    const original = note();
    put(first, original);
    first.close();
    first = new AnnotationStore(path);
    second = new AnnotationStore(path);
    assert.deepEqual(second.list("project", "session"), [original]);
    assert.deepEqual(second.list("other-project", "session"), []);
    assert.deepEqual(second.list("project", "other-session"), []);
    const updated = { ...original, version: 2, body: "Updated from another browser" };
    put(second, updated, 1);
    assert.throws(() => put(first!, { ...original, version: 2, body: "Stale edit" }, 1), /changed/);
    assert.deepEqual(first.list("project", "session"), [updated]);
    assert.throws(() => put(first!, note({ scope: "another-session" })), /scope/);
    assert.throws(() => put(first!, note({ path: "../escape" })), /Invalid/);
    assert.throws(() => put(first!, note({ body: "é".repeat(4096) })), /Invalid/);
    for (let i = 1; i < MAX_ANNOTATIONS; i++) put(first, note());
    assert.throws(() => put(second!, note()), /at most/);
    assert.equal(first.list("project", "session").length, MAX_ANNOTATIONS);
    first.deleteSession("session");
    assert.deepEqual(second.list("project", "session"), []);
    put(second, note());
    first.deleteProject("project");
    assert.deepEqual(second.list("project", "session"), []);
  } finally {
    first?.close();
    second?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a future database schema fails closed without erasing saved drafts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pylon-notes-schema-"));
  const path = join(dir, "notes.sqlite");
  try {
    const store = new AnnotationStore(path);
    const original = note();
    store.mutate("project", "session", {
      sessionId: "session",
      expectedGeneration: 1,
      id: original.id,
      note: original,
    });
    store.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=99");
    db.close();
    assert.throws(() => new AnnotationStore(path), /Unsupported/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT count(*) AS n FROM notes").get()!.n, 1);
    check.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new-side range capture rejects folds, mixed files and deletion-only selection; source copy stays source-only", async () => {
  const rows = [
    { file: 0, kind: "context" as const, text: "before", newLine: 10 },
    { file: 0, kind: "deletion" as const, text: "removed", oldLine: 11 },
    { file: 0, kind: "addition" as const, text: "after", newLine: 11 },
    { file: 0, kind: "gap" as const },
    { file: 0, kind: "context" as const, text: "later", newLine: 20 },
    { file: 1, kind: "context" as const, text: "another file", newLine: 21 },
  ];
  assert.deepEqual(annotationRange(rows, 2, 0), { file: 0, from: 10, to: 11, code: "before\nafter" });
  assert.equal(annotationRange(rows, 1, 1), undefined);
  assert.equal(annotationRange(rows, 0, 4), undefined);
  assert.equal(annotationRange(rows, 4, 5), undefined);
  assert.equal(annotationRange([rows[0], rows[4]], 0, 1), undefined);
  assert.equal(selectedText(rows.slice(0, 3), 0, 2), "before\nremoved\nafter");
  const source = "\uFEFFbefore\r\nsave();\r\nreturn;";
  const captured = await captureAnnotation(
    { from: 2, to: 3, code: "save();\r\nreturn;" },
    "src/store.ts",
    { kind: "current", revision: "working copy" },
    source,
  );
  assert.equal(captured.code, "save();\r\nreturn;");
  assert.equal(captured.hash, await sourceHash(source));
  await assert.rejects(
    captureAnnotation(
      { from: 2, to: 3, code: "wrong\nlines" },
      "src/store.ts",
      { kind: "current", revision: "working copy" },
      source,
    ),
    /changed/,
  );
  await assert.rejects(
    captureAnnotation({ from: 1, to: 1, code: "text" }, "src/store.ts", { kind: "current", revision: "working copy" }),
    /Full source/,
  );
});

test("preflight batches source reads, preserves frozen excerpts and makes historical/stale input explicit", async () => {
  const source = "before\nsave();\nreturn;";
  const captured = note({ kind: "current", hash: await sourceHash(source) });
  const other = note({ ...captured, id: randomUUID(), body: "Second concern" });
  const historical = note();
  let reads = 0;
  const reviewed = await reviewAnnotations([captured, other, historical], async path => {
    assert.equal(path, captured.path);
    reads++;
    return source;
  });
  assert.equal(reads, 1);
  assert.deepEqual(
    reviewed.map(item => item.state),
    ["current", "current", "historical"],
  );
  const stale = await reviewAnnotations([captured], async () => "inserted\n" + source);
  assert.equal(stale[0].state, "changed");
  assert.equal(
    (
      await reviewAnnotations([captured], async () => {
        throw new Error("deleted");
      })
    )[0].state,
    "unavailable",
  );
  const maliciousFormatting = { ...captured, body: "Use ```fences``` without executing /login", code: "```\n```" };
  const prompt = annotationPrompt("/login provider", [{ note: maliciousFormatting, state: "changed" }]);
  assert.ok(prompt.startsWith("Code review notes\n"));
  assert.ok(prompt.includes("/login provider"));
  assert.ok(prompt.includes("````\n```\n```\n````"));
  assert.ok(prompt.includes("current; changed"));
  captured.body = "Edited after sending";
  assert.ok(!prompt.includes(captured.body));
  assert.throws(() => annotationPrompt("é".repeat(32768), reviewed), /64 KiB/);
  assert.equal(annotationPrompt("ordinary message", []), "ordinary message");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
test("late reads and reversed mutation responses cannot replace newer draft lists", async () => {
  const gate = new AnnotationReads();
  const first = note();
  const second = note();
  let durable: AnnotationList = { scope: first.scope, sessionId: "session", sessionGeneration: 1, notes: [first] };
  let displayed: AnnotationList | undefined;
  const apply = (list: AnnotationList) => {
    displayed = list;
  };
  const fail = (error: unknown) => {
    throw error;
  };
  const oldRead = deferred<AnnotationList>();
  const before = gate.read(() => oldRead.promise, apply, fail);
  const ackA = deferred<void>();
  const ackB = deferred<void>();
  const reload = () => gate.read(async () => structuredClone(durable), apply, fail);
  const saveA = persistAnnotation(
    first,
    first.id,
    () => ackA.promise,
    reload,
    () => {},
  );
  durable = { ...durable, notes: [first, second] };
  const saveB = persistAnnotation(
    second,
    second.id,
    () => ackB.promise,
    reload,
    () => {},
  );
  ackB.resolve();
  await saveB;
  ackA.resolve();
  await saveA;
  oldRead.resolve({ ...durable, notes: [first] });
  await before;
  assert.deepEqual(displayed?.notes, [first, second]);
  // A session change invalidates pending GETs and stops old mutations before starting another GET.
  const oldSessionAck = deferred<void>();
  let current = true;
  let reloads = 0;
  const pending = persistAnnotation(
    first,
    first.id,
    () => oldSessionAck.promise,
    async () => {
      reloads++;
      return durable;
    },
    () => {
      if (!current) throw new Error("Session changed");
    },
  );
  current = false;
  gate.invalidate();
  oldSessionAck.resolve();
  await assert.rejects(pending, /Session changed/);
  assert.equal(reloads, 0);
});
test("lost successful save responses reconcile identical durable data but preserve conflicting edits", async () => {
  const original = note();
  const latest: AnnotationList = {
    scope: original.scope,
    sessionId: "session",
    sessionGeneration: 1,
    notes: [original],
  };
  const lost = async () => {
    throw new Error("connection lost");
  };
  await persistAnnotation(
    original,
    original.id,
    lost,
    async () => latest,
    () => {},
  );
  await assert.rejects(
    persistAnnotation(
      { ...original, body: "different edit" },
      original.id,
      lost,
      async () => latest,
      () => {},
    ),
    /connection lost/,
  );
  await assert.rejects(
    persistAnnotation(
      original,
      original.id,
      async () => {},
      async () => undefined,
      () => {},
    ),
    /confirm/,
  );
  assert.equal(validAnnotation({ ...original, unexpected: "unbounded payload" }), false);
  await assert.rejects(
    captureAnnotation({ from: 2, to: 2, code: "" }, "file.ts", { kind: "current", revision: "r" }, "one line"),
    /changed/,
  );
});
