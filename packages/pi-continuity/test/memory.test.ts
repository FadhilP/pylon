import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { compact, candidate, factsForOwners, normalizeCandidatesFile, normalizeMemoryFile, isMemoryFile, MEMORY_SCHEMA_VERSION, type Fact } from "../src/memory.ts";
import { readJson, readVersionedJson, writeJson } from "../src/storage.ts";
import { captureEvidence, classifyProjectFacts, projectContext } from "../src/worktree.ts";

const exec = promisify(execFile);

test("memory deterministic", () => {
  const c = candidate({
    key: "workflow.test",
    kind: "workflow",
    text: "npm test",
    source: "README",
    confidence: 1,
    action: "add",
  });
  const result = compact([], [c]);
  assert.equal(result.facts.length, 1);
  assert.deepEqual(result.candidates, []);
});
test("V4 candidate queue drops malformed records without losing valid records", () => {
  const pending = candidate({ text: "npm test" });
  const normalized = normalizeCandidatesFile({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    candidates: [pending, { ...pending, id: "broken", text: "" }],
  });
  assert.deepEqual(normalized?.candidates, [pending]);
  assert.equal(normalizeCandidatesFile({ schemaVersion: 1, candidates: [pending] }), undefined);
});
test("memory is keyed and retention favors preferences and warnings", () => {
  const first = candidate({
      key: "workflow.test", kind: "workflow", text: "npm test", source: "README",
      confidence: 1, action: "add",
    }),
    second = candidate({
      key: "workflow.test", kind: "workflow", text: "npm run test", source: "package.json",
      confidence: 1, action: "add",
    });
  const keyed = compact([], [first, second]);
  assert.equal(keyed.facts.length, 1);
  assert.equal(keyed.facts[0].text, "npm run test");

  const facts: Fact[] = [
    { key: "workflow.build", kind: "workflow", text: "Build", source: "scripts", confidence: 1, updatedAt: "2026-03-01" },
    { key: "warning.deploy", kind: "warning", text: "Check deploy", source: "README", confidence: 0.5, updatedAt: "2026-02-01" },
    { key: "preference.style", kind: "preference", text: "Keep output terse", source: "user", confidence: 0.5, updatedAt: "2026-01-01" },
  ];
  assert.deepEqual(
    compact(facts, [], 2).facts.map((fact) => fact.key),
    ["preference.style", "warning.deploy"],
  );
});
test("V4 memory keeps valid records and resets unsupported files", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-"));
  const path = join(root, "memory.json");
  const valid = compact([], [candidate({ text: "Run npm test" })]).facts[0]!;
  await writeJson(path, { schemaVersion: MEMORY_SCHEMA_VERSION, facts: [valid, { bad: true }] });
  const loaded = normalizeMemoryFile(await readJson(
    path, { schemaVersion: MEMORY_SCHEMA_VERSION, facts: [] as Fact[] }, isMemoryFile,
  ));
  assert.deepEqual(loaded?.facts, [valid]);
  await writeJson(path, { schemaVersion: 1, facts: [] });
  const reset = await readVersionedJson(path, { schemaVersion: MEMORY_SCHEMA_VERSION, facts: [] as Fact[] }, isMemoryFile);
  assert.deepEqual(reset.facts, []);
  assert.ok((await readdir(root)).some((name) => name.startsWith("memory.json.reset-unsupported-")));
});

test("text-only add defaults and replace/remove require keys", () => {
  const added = candidate({ text: "Use npm test" });
  assert.equal(added.kind, "workflow");
  assert.equal(added.confidence, 0.5);
  assert.equal(added.scope, "project");
  assert.match(added.key, /^memory\./);
  assert.throws(() => candidate({ action: "replace", text: "x" }), /requires a key/);
  assert.throws(() => candidate({ action: "replace", key: "x" }), /requires text/);
  assert.throws(() => candidate({ action: "remove" }), /requires a key/);
  assert.throws(() => candidate({ action: "remove", key: "x" }), /nonempty source/);
  const removal = candidate({ action: "remove", key: "x", source: "repository contradicted it" }, {
    owner: "project", captureCommit: "a".repeat(40),
    evidencePaths: [{ path: "package.json", sha256: "b".repeat(64) }],
  });
  assert.equal(removal.source, "repository contradicted it");
  assert.equal(removal.evidencePaths?.[0]?.path, "package.json");
  assert.throws(() => candidate({ action: "invalid" as any, text: "x" }), /invalid memory action/);
  assert.throws(() => candidate({ text: "x".repeat(1001) }), /field limits/);
});

test("compaction keeps 30 global user facts and 30 facts per project", () => {
  const sameKey = compact([], [
    candidate({ key: "same", text: "user", scope: "user" }, { owner: "default" }),
    candidate({ key: "same", text: "project" }, { owner: "project-a" }),
  ]).facts;
  assert.equal(sameKey.length, 2);
  const afterProjectRemove = compact(sameKey, [candidate({
    action: "remove", key: "same", source: "project evidence contradicted it",
  }, { owner: "project-a" })]).facts;
  assert.deepEqual(afterProjectRemove.map((fact) => `${fact.scope}/${fact.key}`), ["user/same"]);
  const candidates = [
    ...Array.from({ length: 31 }, (_, i) => candidate({ key: `user-${i}`, text: `user ${i}`, scope: "user" }, { owner: "default" })),
    ...Array.from({ length: 31 }, (_, i) => candidate({ key: `a-${i}`, text: `project a ${i}` }, { owner: "project-a" })),
    ...Array.from({ length: 31 }, (_, i) => candidate({ key: `b-${i}`, text: `project b ${i}` }, { owner: "project-b" })),
  ];
  const facts = compact([], candidates).facts;
  assert.equal(facts.filter((fact) => fact.scope === "user").length, 30);
  assert.equal(facts.filter((fact) => fact.owner === "project-a").length, 30);
  assert.equal(facts.filter((fact) => fact.owner === "project-b").length, 30);
});

test("memory visibility includes global user facts and isolates projects", () => {
  const facts = compact([], [
    candidate({ key: "user", text: "user fact", scope: "user" }, { owner: "default" }),
    candidate({ key: "project-a", text: "first project", scope: "project" }, { owner: "project-a" }),
    candidate({ key: "project-b", text: "second project", scope: "project" }, { owner: "project-b" }),
  ]).facts;
  assert.deepEqual(
    factsForOwners(facts, "project-a").map((fact) => fact.key).sort(),
    ["project-a", "user"],
  );
});
test("non-Git projects use the supplied canonical workspace identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-non-git-"));
  assert.deepEqual(await projectContext(root, "workspace-id"), { owner: "workspace-id" });
});

test("linked worktrees share project identity while divergence is suspect, not deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-git-"));
  const base = join(root, "base"), linked = join(root, "linked");
  await exec("git", ["init", "-q", base]);
  await exec("git", ["-C", base, "config", "user.email", "test@example.invalid"]);
  await exec("git", ["-C", base, "config", "user.name", "test"]);
  await writeFile(join(base, "file.txt"), "base\n");
  await exec("git", ["-C", base, "add", "."]);
  await exec("git", ["-C", base, "commit", "-qm", "base"]);
  await exec("git", ["-C", base, "worktree", "add", "-q", "-b", "linked", linked]);
  const main = await projectContext(base, "base"), other = await projectContext(linked, "linked");
  assert.equal(main.owner, other.owner);
  const evidencePaths = await captureEvidence(base, ["file.txt"]);
  const fact = compact([], [candidate({ key: "workflow.test", text: "Run tests", scope: "project" }, {
    owner: main.owner, captureCommit: main.captureCommit, evidencePaths,
  })]).facts;
  assert.equal((await classifyProjectFacts(linked, fact))[0]!.status, "active");
  await exec("git", ["-C", linked, "checkout", "--orphan", "rebased"]);
  await writeFile(join(linked, "other.txt"), "unrelated\n");
  await exec("git", ["-C", linked, "add", "."]);
  await exec("git", ["-C", linked, "commit", "-qm", "unrelated"]);
  assert.equal((await classifyProjectFacts(linked, fact))[0]!.status, "suspect");
  assert.equal((await classifyProjectFacts(linked, [{ ...fact[0]!, captureCommit: "0".repeat(40) }]))[0]!.status, "unverifiable");
  assert.equal(fact.length, 1, "suspect facts remain persisted");
  await exec("git", ["-C", linked, "checkout", "-q", "linked"]);
  assert.equal((await classifyProjectFacts(linked, fact))[0]!.status, "active", "returning to captured history revives fact");
});

test("evidence is hashed server-side and changed evidence is suspect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "continuity-evidence-"));
  await writeFile(join(root, "guide.txt"), "first\n");
  const evidencePaths = await captureEvidence(root, ["guide.txt"]);
  assert.match(evidencePaths[0]!.sha256, /^[0-9a-f]{64}$/);
  const fact: Fact = {
    key: "guide", kind: "workflow", text: "follow guide", source: "guide", confidence: 1,
    updatedAt: new Date().toISOString(), scope: "project", owner: "project", evidencePaths,
  };
  assert.equal((await classifyProjectFacts(root, [fact]))[0]!.status, "active");
  await writeFile(join(root, "guide.txt"), "changed\n");
  assert.equal((await classifyProjectFacts(root, [fact]))[0]!.status, "suspect");
  await rm(join(root, "guide.txt"));
  assert.equal((await classifyProjectFacts(root, [fact]))[0]!.status, "suspect");
  assert.equal((await classifyProjectFacts(root, [{ ...fact, evidencePaths: undefined }]))[0]!.status, "unchecked");
  await assert.rejects(captureEvidence(root, ["../guide.txt"]), /invalid|escape/);
  await writeFile(join(root, ".env"), "secret\n");
  await assert.rejects(captureEvidence(root, [".env"]), /sensitive/);
  const outside = join(root, "outside"), linked = join(root, "linked");
  await mkdir(outside);
  await writeFile(join(outside, "guide.txt"), "outside\n");
  try {
    await symlink(outside, linked, "junction");
    await assert.rejects(captureEvidence(root, ["linked/guide.txt"]), /symlink/);
  } catch (error: any) {
    if (error?.code !== "EPERM") throw error;
    t.diagnostic("symlink creation unavailable; escape rejection covered by traversal test");
  }
});

test("retention evicts suspect facts before active facts", () => {
  const facts = Array.from({ length: 31 }, (_, index) => compact([], [candidate({
    key: `fact-${index}`, text: `fact ${index}`, source: "test",
  })]).facts[0]!);
  const statuses = new Map(facts.map((fact, index) => [
    `${fact.scope}\0${fact.owner}\0${fact.key}`, index === 0 ? "suspect" as const : "active" as const,
  ]));
  assert.equal(compact(facts, [], 30, statuses).facts.some((fact) => fact.key === "fact-0"), false);
});

