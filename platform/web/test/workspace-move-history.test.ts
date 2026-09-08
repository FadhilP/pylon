import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateWorkspace, readWorkspaceEntry } from "../src/server/workspace/workspace-mutations.ts";
import type { WorkspaceMutation } from "../src/shared/workspace/workspace-mutations.ts";
import { WorkspaceMoveHistory, type MovePlan } from "../src/client/workspace/workspace-move-history.ts";
import { WorkspaceDraftStore } from "../src/client/workspace/workspace-edit-state.ts";
import { selectWorkspacePaths, topLevelPaths } from "../src/client/workspace/workspace-selection.ts";
import { planFolderMove, workspaceMoveInventory } from "../src/client/workspace/workspace-move.ts";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-move-history-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "dest"));
  await writeFile(join(cwd, "a"), "alpha");
  await writeFile(join(cwd, "b"), "beta");
  const drafts = new WorkspaceDraftStore();
  const applied: WorkspaceMutation[] = [];
  const reconciled: WorkspaceMutation[] = [];
  let generation = 1;
  const hooks: {
    read?: (path: string, destination?: string) => void | Promise<void>;
    mutate?: (mutation: WorkspaceMutation) => void | Promise<void>;
  } = {};
  const runtime = {
    async workspaceEntry(path: string, sessionId: string, expectedGeneration: number, destination?: string) {
      assert.equal(sessionId, "session");
      if (expectedGeneration !== generation) throw new Error("Session changed.");
      await hooks.read?.(path, destination);
      return { ...await readWorkspaceEntry(cwd, path, destination), sessionId, sessionGeneration: generation };
    },
    async mutateWorkspace(mutation: WorkspaceMutation, sessionId: string, expectedGeneration: number) {
      assert.equal(sessionId, "session");
      if (expectedGeneration !== generation) throw new Error("Session changed.");
      await mutateWorkspace(cwd, mutation);
      applied.push(mutation);
      await hooks.mutate?.(mutation);
    },
  };
  const history = new WorkspaceMoveHistory(runtime, drafts);
  const reconcile = (mutation: WorkspaceMutation) => { reconciled.push(mutation); };
  const move = (plans: MovePlan[]) => history.move(plans, "session", 1, reconcile);
  const replay = (direction: "undo" | "redo") => history.replay(direction, "session", 1, reconcile);
  return { cwd, history, drafts, applied, reconciled, runtime, hooks, move, replay, switchSession: () => { generation++; } };
}

test("toggle/range selection uses visible order and moves selected ancestors only once", () => {
  const visible = ["src", "src/a", "src/b", "other", "other/a"];
  let selection = selectWorkspacePaths([], undefined, "src/a", visible, { toggle: false, range: false });
  selection = selectWorkspacePaths(selection.paths, selection.anchor, "other", visible, { toggle: true, range: false });
  assert.deepEqual(selection.paths, ["src/a", "other"]);
  selection = selectWorkspacePaths(selection.paths, selection.anchor, "src/b", visible, { toggle: false, range: true });
  assert.deepEqual(selection.paths, ["src/b", "other"]);
  selection = selectWorkspacePaths(selection.paths, selection.anchor, "src/b", visible, { toggle: true, range: false });
  assert.deepEqual(selection.paths, ["other"]);
  assert.deepEqual(topLevelPaths(["src/a", "src", "src/b", "other", "src"]), ["src", "other"]);
  assert.deepEqual(selectWorkspacePaths(["hidden"], "hidden", "other", visible, { toggle: true, range: true }).paths, ["other"]);
  const inventory = workspaceMoveInventory([{ path: "src/a" }, { path: "other/a" }, { path: "dest", kind: "directory" }]);
  assert.deepEqual(planFolderMove(["src", "src/a"], "dest", inventory), [{ path: "src", destination: "dest/src" }]);
  assert.throws(() => planFolderMove(["src/a", "other/a"], "dest", inventory), /conflicting/);
});

test("repeated moves undo and redo using identity/content while strict path versions change", async t => {
  const f = await fixture(t);
  const original = await readWorkspaceEntry(f.cwd, "a");
  assert.equal((await f.move([{ path: "a", destination: "dest/a" }])).error, undefined);
  assert.equal((await f.move([{ path: "dest/a", destination: "c" }])).error, undefined);
  assert.equal((await f.replay("undo")).error, undefined);
  const restored = await readWorkspaceEntry(f.cwd, "dest/a");
  assert.equal(restored.moveFingerprint, original.moveFingerprint);
  assert.notEqual(restored.version, original.version);
  assert.equal((await f.replay("undo")).error, undefined);
  assert.equal(await readFile(join(f.cwd, "a"), "utf8"), "alpha");
  assert.equal((await f.replay("redo")).error, undefined);
  assert.equal((await f.replay("redo")).error, undefined);
  assert.equal(await readFile(join(f.cwd, "c"), "utf8"), "alpha");
  assert.equal(f.reconciled.length, 6);
  await f.replay("undo");
  await f.move([{ path: "b", destination: "dest/b" }]);
  assert.equal(f.history.canRedo, false);
});

test("parent and child moves can be reversed without accepting changes to the parent's contents", async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, "folder"));
  await writeFile(join(f.cwd, "folder", "child"), "nested");
  assert.equal((await f.move([{ path: "folder", destination: "dest/folder" }])).error, undefined);
  assert.equal((await f.move([{ path: "dest/folder/child", destination: "child" }])).error, undefined);
  assert.equal((await f.replay("undo")).error, undefined);
  assert.equal((await f.replay("undo")).error, undefined);
  assert.equal(await readFile(join(f.cwd, "folder/child"), "utf8"), "nested");
  assert.equal((await f.replay("redo")).error, undefined);
  await writeFile(join(f.cwd, "dest/folder/new"), "external");
  const result = await f.replay("undo");
  assert.match(result.error!, /changed on disk/);
  assert.equal(await readFile(join(f.cwd, "dest/folder/new"), "utf8"), "external");
});

test("whole-batch server preflight prevents early writes on occupied destinations, dirty drafts and stale versions", async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "dest/b"), "occupied");
  const plans = [{ path: "a", destination: "dest/a" }, { path: "b", destination: "dest/b" }];
  assert.match((await f.move(plans)).error!, /already exists/);
  assert.equal(f.applied.length, 0);
  assert.equal(await readFile(join(f.cwd, "a"), "utf8"), "alpha");
  await rm(join(f.cwd, "dest/b"));
  const entry = await f.runtime.workspaceEntry("b", "session", 1);
  f.drafts.open(entry);
  f.drafts.change("session", "b", "unsaved");
  assert.match((await f.move(plans)).error!, /drafts/);
  f.drafts.change("session", "b", "beta");
  assert.match((await f.move([{ ...plans[0], expectedVersion: "stale" }])).error!, /changed on disk/);
  assert.equal(f.applied.length, 0);
  f.switchSession();
  assert.match((await f.move(plans)).error!, /Session changed/);
  assert.equal(f.applied.length, 0);
});

test("partial undo keeps remaining work retryable and disables redo until completion", async t => {
  const f = await fixture(t);
  assert.equal((await f.move([{ path: "a", destination: "dest/a" }, { path: "b", destination: "dest/b" }])).error, undefined);
  f.hooks.read = (path, destination) => {
    if (f.applied.length === 3 && path === "dest/a" && destination === "a") throw new Error("temporary inspection failure");
  };
  const partial = await f.replay("undo");
  assert.equal(partial.completed, 1);
  assert.match(partial.error!, /1 of 2/);
  assert.equal(f.history.canUndo, true);
  assert.equal(f.history.canRedo, false);
  assert.equal((await f.move([{ path: "b", destination: "new-b" }])).completed, 0);
  f.hooks.read = undefined;
  assert.equal((await f.replay("undo")).error, undefined);
  assert.equal((await f.replay("redo")).completed, 2);
  assert.deepEqual(await readdir(join(f.cwd, "dest")), ["a", "b"]);
  assert.equal((await f.replay("undo")).completed, 2);
  const beforeRedo = f.applied.length;
  f.hooks.read = (path, destination) => {
    if (f.applied.length === beforeRedo + 1 && path === "b" && destination === "dest/b") throw new Error("temporary redo failure");
  };
  assert.equal((await f.replay("redo")).completed, 1);
  assert.equal(f.history.canRedo, true);
  assert.equal(f.history.canUndo, false);
  f.hooks.read = undefined;
  assert.equal((await f.replay("redo")).completed, 1);
  assert.equal(f.history.canUndo, true);
  assert.deepEqual(await readdir(join(f.cwd, "dest")), ["a", "b"]);
});

test("partial forward moves record only verified successes and release draft locks", async t => {
  const f = await fixture(t);
  f.drafts.open(await f.runtime.workspaceEntry("a", "session", 1));
  f.hooks.mutate = () => {
    assert.equal(f.drafts.locked("session", "a"), true);
    f.drafts.change("session", "a", "late edit");
    assert.equal(f.drafts.get("session", "a")?.text, "alpha");
  };
  f.hooks.read = (path, destination) => {
    if (f.applied.length === 1 && path === "b" && destination) throw new Error("external change before second move");
  };
  const result = await f.move([{ path: "a", destination: "dest/a" }, { path: "b", destination: "dest/b" }]);
  assert.equal(result.completed, 1);
  assert.equal(f.history.canUndo, true);
  assert.equal(f.drafts.locked("session", "a"), false);
  f.hooks.read = undefined; f.hooks.mutate = undefined;
  assert.equal((await f.replay("undo")).completed, 1);
  assert.equal(await readFile(join(f.cwd, "b"), "utf8"), "beta");
});

test("external replacement, occupied undo destinations and unknown outcomes never get silently adopted", async t => {
  const f = await fixture(t);
  await f.move([{ path: "a", destination: "dest/a" }]);
  await writeFile(join(f.cwd, "a"), "occupied");
  assert.match((await f.replay("undo")).error!, /already exists/);
  await rm(join(f.cwd, "a"));
  await writeFile(join(f.cwd, "replacement"), "alpha");
  await rename(join(f.cwd, "dest/a"), join(f.cwd, "original"));
  await rename(join(f.cwd, "replacement"), join(f.cwd, "dest/a"));
  assert.match((await f.replay("undo")).error!, /changed on disk/);
  f.history.clear();
  f.hooks.mutate = async mutation => {
    if (mutation.action === "move") await writeFile(join(f.cwd, mutation.destination), "changed during move");
  };
  const result = await f.move([{ path: "b", destination: "dest/b" }]);
  assert.match(result.error!, /uncertain outcome/);
  assert.equal(result.completed, 0);
  assert.equal(f.history.canUndo, false);
  assert.equal(f.history.canRedo, false);
  assert.equal(f.drafts.locked("session", "b"), false);
  assert.equal(await readFile(join(f.cwd, "dest/b"), "utf8"), "changed during move");
  f.history.clear();
  assert.equal(f.history.blocked, undefined);
});

test("lost move acknowledgements block history instead of retrying or pretending nothing changed", async t => {
  const f = await fixture(t);
  f.hooks.mutate = () => { throw new Error("response lost after write"); };
  const result = await f.move([{ path: "a", destination: "dest/a" }]);
  assert.match(result.error!, /uncertain outcome/);
  assert.equal(await readFile(join(f.cwd, "dest/a"), "utf8"), "alpha");
  assert.equal(f.reconciled.length, 0);
  assert.equal(f.history.canUndo, false);
  assert.equal(f.drafts.locked("session", "a"), false);
  assert.equal((await f.move([{ path: "b", destination: "dest/b" }])).completed, 0);
  assert.equal(f.applied.length, 1);
});
