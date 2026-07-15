import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compact,
  candidate,
  normalizeCandidatesFile,
  isMemoryFile,
  type PendingCandidate,
  type Fact,
} from "../src/memory.ts";
import { readJson, updateJson, writeJson } from "../src/storage.ts";
import { registerWorkspace } from "../src/workspace.ts";
import { blocked } from "../src/plan-gate.ts";
import { buildContext } from "../src/context.ts";
import {
  fresh,
  setPlan,
  updateTodo,
  hasRemainingTodos,
  isWork,
  sessionWorkFile,
} from "../src/active-work.ts";
import { validateQuestion } from "../src/questions.ts";
import {
  defaultConfig,
  loadConfig,
  parseModelRef,
  saveConfig,
} from "../src/config.ts";
import { isRunEntry, runTimelineId } from "../src/run.ts";
test("model profiles parse, persist, and reset to defaults", async () => {
  assert.deepEqual(parseModelRef("provider/model:high"), {
    provider: "provider",
    id: "model",
    thinking: "high",
  });
  assert.deepEqual(parseModelRef("provider/model:version"), {
    provider: "provider",
    id: "model:version",
  });
  const root = await mkdtemp(join(tmpdir(), "continuity-config-"));
  const path = join(root, "config.json");
  await saveConfig(
    {
      version: 1,
      planner: { model: "provider/planner", thinking: "high" },
      executor: { model: "provider/executor" },
    },
    path,
  );
  assert.deepEqual(await loadConfig(path), {
    version: 1,
    planner: { model: "provider/planner", thinking: "high" },
    executor: { model: "provider/executor" },
  });
  assert.deepEqual(defaultConfig(), { version: 1 });
});

test("run metadata validates backward-compatible timeline lineage", () => {
  const legacy = {
    version: 1 as const,
    runId: "run",
    role: "planner" as const,
    createdAt: new Date().toISOString(),
  };
  assert.equal(isRunEntry(legacy), true);
  assert.equal(runTimelineId(legacy), "run");
  assert.equal(isRunEntry({ ...legacy, runId: "run-2", timelineId: "run" }), true);
  assert.equal(runTimelineId({ ...legacy, runId: "run-2", timelineId: "run" }), "run");
  assert.equal(isRunEntry({ ...legacy, timelineId: "" }), false);
  assert.equal(
    isRunEntry({ version: 1, runId: "run", role: "invalid", createdAt: "x" }),
    false,
  );
});

test("session work files are isolated", () => {
  assert.notEqual(sessionWorkFile("session-a"), sessionWorkFile("session-b"));
  assert.equal(sessionWorkFile("../session"), "..%2Fsession.json");
});
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
test("candidate queue normalizes legacy pending entries and drops decided history", () => {
  const pending = candidate({
    key: "workflow.test",
    kind: "workflow",
    text: "npm test",
    source: "README",
    confidence: 1,
    action: "add",
  });
  assert.equal("status" in pending, false);
  const normalized = normalizeCandidatesFile({
    schemaVersion: 1,
    candidates: [
      { ...pending, status: "pending", decidedAt: "2026-01-01" },
      { ...pending, id: "applied", status: "applied" },
      { ...pending, id: "rejected", status: "rejected" },
    ],
  });
  assert.deepEqual(normalized?.candidates, [pending]);
  assert.equal(
    normalizeCandidatesFile({
      schemaVersion: 1,
      candidates: [{ ...pending, status: "unknown" }],
    }),
    undefined,
  );
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
test("memory persists, compacts, reloads, and reaches child context", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-memory-"));
  const parentPath = join(root, "repo");
  const childPath = join(parentPath, "package");
  await mkdir(childPath, { recursive: true });
  const parent = await registerWorkspace(root, parentPath);
  const child = await registerWorkspace(root, childPath);
  assert.equal(child.workspace.parentId, parent.workspace.id);
  const pending = candidate({
    key: "workflow.test",
    kind: "workflow",
    text: "Run npm test",
    source: "README",
    confidence: 1,
    action: "add",
  });
  const candidatePath = join(parent.dir, "candidates.json");
  await writeJson(candidatePath, { schemaVersion: 1, candidates: [pending] });
  const loadedCandidateFile = await readJson(
    candidatePath,
    { schemaVersion: 1 as const, candidates: [] as PendingCandidate[] },
    (value) => normalizeCandidatesFile(value) !== undefined,
  );
  const loadedCandidates = normalizeCandidatesFile(loadedCandidateFile)!;
  const compacted = compact([], loadedCandidates.candidates);
  await writeJson(candidatePath, { schemaVersion: 1, candidates: compacted.candidates });
  const memoryPath = join(parent.dir, "memory.json");
  await writeJson(memoryPath, { schemaVersion: 1, facts: compacted.facts });
  const loadedMemory = await readJson(
    memoryPath,
    { schemaVersion: 1 as const, facts: [] as Fact[] },
    isMemoryFile,
  );
  assert.match(
    buildContext(undefined, [], "npm test", 900, loadedMemory.facts),
    /Parent memory workflow\.test: Run npm test/,
  );
  const decidedCandidateFile = await readJson(
    candidatePath,
    { schemaVersion: 1 as const, candidates: [] as PendingCandidate[] },
    (value) => normalizeCandidatesFile(value) !== undefined,
  );
  assert.deepEqual(normalizeCandidatesFile(decidedCandidateFile)?.candidates, []);
  await writeJson(memoryPath, { schemaVersion: 1, facts: [{ bad: true }] });
  const rejectedMemory = await readJson(
    memoryPath,
    { schemaVersion: 1 as const, facts: [] as Fact[] },
    isMemoryFile,
  );
  assert.deepEqual(rejectedMemory.facts, []);
  assert.ok((await readdir(parent.dir)).some((name) => name.startsWith("memory.json.corrupt-")));
});
test("gate fail closed", () => {
  for (const x of ["edit", "write", "bash", "other"])
    assert.equal(blocked(true, x), true);
  for (const x of [
    "read",
    "grep",
    "find",
    "ls",
    "continuity_update",
    "repo_scout",
    "advisor",
  ])
    assert.equal(blocked(true, x), false);
});
test("empty continuity state injects no context", () => {
  assert.equal(buildContext(undefined, [], ""), "");
});
test("context bounded active first", () => {
  const w = fresh("goal");
  assert.ok(buildContext(w, [], "", 20).length <= 80);
});
test("context includes preferences but rejects weak one-word memory matches", () => {
  const facts: Fact[] = [
    { key: "preference.style", kind: "preference", text: "Keep output terse", source: "user", confidence: 1, updatedAt: "2026-01-01" },
    { key: "workflow.release", kind: "workflow", text: "Run release check", source: "README", confidence: 1, updatedAt: "2026-01-01" },
  ];
  const text = buildContext(undefined, facts, "discuss release migrations");
  assert.match(text, /Memory preference\.style: Keep output terse/);
  assert.doesNotMatch(text, /workflow\.release/);
});
test("context accepts two-term and exact-identifier memory matches", () => {
  const facts: Fact[] = [
    { key: "workflow.release", kind: "workflow", text: "Run release check", source: "README", confidence: 1, updatedAt: "2026-01-01" },
    { key: "architecture.web_scout", kind: "architecture", text: "Use web_scout for public research", source: "source", confidence: 1, updatedAt: "2026-01-01" },
  ];
  assert.match(buildContext(undefined, facts, "release check"), /workflow\.release/);
  assert.match(buildContext(undefined, facts, "call web_scout"), /architecture\.web_scout/);
});
test("context exposes exact todo IDs and status", () => {
  const w = fresh("goal");
  setPlan(w, ["inspect"]);
  const text = buildContext(w, [], "", 900);
  assert.match(text, /Todo todo_1 \[pending\]: inspect/);
});
test("plan refresh preserves todo progress", () => {
  const w = fresh("goal");
  setPlan(w, ["inspect", "fix"], "1");
  assert.equal(updateTodo(w, "todo_1", "done", "2"), true);
  setPlan(w, ["inspect", "test"], "3");
  assert.equal(w.todos[0].status, "done");
  assert.equal(w.todos[1].status, "pending");
  assert.equal(new Set(w.todos.map((t) => t.id)).size, 2);
  assert.equal(hasRemainingTodos(w), true);
  updateTodo(w, w.todos[1].id, "done", "4");
  assert.equal(hasRemainingTodos(w), false);
});
test("todo current state follows status", () => {
  const w = fresh();
  setPlan(w, ["work"]);
  assert.equal(updateTodo(w, "todo_1", "in_progress"), true);
  assert.equal(w.currentTodoId, "todo_1");
  updateTodo(w, "todo_1", "done");
  assert.equal(w.currentTodoId, undefined);
  assert.equal(updateTodo(w, "missing", "done"), false);
});
test("questions validate", () => {
  assert.throws(() => validateQuestion("q", [{ label: "x" }, { label: "x" }]));
  validateQuestion("q", [{ label: "x" }, { label: "y" }]);
});
test("secret rejected", () =>
  assert.throws(
    () =>
      candidate({
        key: "x",
        kind: "warning",
        text: "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz",
        source: "x",
        confidence: 1,
        action: "add",
      }),
    /possible credential/,
  ));

test("work schema rejects malformed persisted state", () => {
  assert.equal(isWork(fresh("goal")), true);
  assert.equal(
    isWork({
      ...fresh("goal"),
      runId: "run",
      timelineId: "timeline",
      baseModel: { provider: "provider", id: "model" },
      baseThinking: "high",
    }),
    true,
  );
  assert.equal(isWork({ ...fresh("goal"), runId: "" }), false);
  assert.equal(isWork({ ...fresh("goal"), timelineId: "" }), false);
  assert.equal(isWork({ ...fresh("goal"), schemaVersion: 2 }), false);
  assert.equal(isWork({ ...fresh("goal"), todos: [{ bad: true }] }), false);
});

test("concurrent JSON updates do not lose writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-update-"));
  const path = join(root, "state.json");
  await Promise.all(
    Array.from({ length: 20 }, (_, value) =>
      updateJson<number[]>(path, [], (items) => [...items, value], Array.isArray),
    ),
  );
  const items = await readJson<number[]>(path, [], Array.isArray);
  assert.equal(items.length, 20);
  assert.equal(new Set(items).size, 20);
});
