import test from "node:test";
import assert from "node:assert/strict";
import type { WorkspaceEntry, WorkspaceMutation } from "../src/shared/workspace/workspace-mutations.ts";
import { WorkspaceDraftStore } from "../src/client/workspace/workspace-edit-state.ts";
import { moveDestination, moveFolderSuggestions, moveTargetError, moveWorkspaceEntry, planFolderMove, workspaceDropDestination, workspaceDropFolder, workspaceMoveInventory } from "../src/client/workspace/workspace-move.ts";

const inventory = workspaceMoveInventory([
  { path: "src/file.ts" },
  { path: "src/nested/deep", kind: "directory" },
  { path: "empty", kind: "directory" },
  { path: "dest/file.ts" },
  { path: "occupied/src/child.ts" },
  { path: "removed/old.ts", status: "deleted" },
  { path: "vendor/module", kind: "submodule" },
]);

test("move suggestions include empty and inferred folders but exclude the current parent, descendants and submodules", () => {
  const folders = moveFolderSuggestions("src", inventory);
  assert.ok(folders.includes("empty"));
  assert.ok(folders.includes("dest"));
  assert.ok(!folders.includes(""));
  assert.ok(!folders.some(folder => folder === "src" || folder.startsWith("src/")));
  assert.ok(!folders.includes("vendor/module"));
  assert.ok(!folders.includes("removed"));
  assert.ok(!folders.includes("dest/file.ts"));
  assert.ok(moveFolderSuggestions("src/file.ts", inventory).includes(""));
  assert.ok(!moveFolderSuggestions("src/file.ts", inventory).includes("src"));
});

test("move validation preserves the name and rejects collisions, self-moves, protected paths and file targets", () => {
  assert.equal(moveDestination("src/file.ts", ""), "file.ts");
  assert.equal(moveDestination("src/nested", "empty"), "empty/nested");
  assert.equal(moveTargetError("src/file.ts", "empty", inventory), undefined);
  assert.match(moveTargetError("src/file.ts", "dest", inventory)!, /already exists/);
  assert.match(moveTargetError("src", "occupied", inventory)!, /already exists/);
  assert.match(moveTargetError("src/file.ts", "src", inventory)!, /different folder/);
  assert.match(moveTargetError("src", "src/nested", inventory)!, /descendants/);
  assert.match(moveTargetError("src", "SRC/nested", inventory)!, /descendants/);
  assert.match(moveTargetError("vendor", "empty", inventory)!, /Submodules/);
  assert.match(moveTargetError("src", "vendor/module", inventory)!, /Submodules/);
  assert.match(moveTargetError("src", "dest/file.ts", inventory)!, /not a file/);
  for (const folder of ["../outside", "/absolute", ".git", "bad\\path"])
    assert.match(moveTargetError("src", folder, inventory)!, /valid workspace-relative/);
  // Inventory may be partial; typed folders remain server-validated rather than silently unavailable.
  assert.equal(moveTargetError("src/file.ts", "not-indexed-yet", inventory), undefined);
});

test("drops require a local source from the same session generation and a live directory or root target", () => {
  const source = { path: "src/file.ts", scope: "session:1" };
  assert.equal(workspaceDropDestination(source, "session:1", "empty", inventory), "empty/file.ts");
  assert.equal(workspaceDropDestination(source, "session:1", "", inventory), "file.ts");
  assert.equal(workspaceDropDestination({ ...source, path: "src" }, "session:1", "empty", inventory), "empty/src");
  assert.equal(workspaceDropDestination(undefined, "session:1", "empty", inventory), undefined);
  for (const scope of ["other:1", "session:2", undefined])
    assert.equal(workspaceDropDestination(source, scope, "empty", inventory), undefined);
  for (const folder of [undefined, "dest/file.ts", "unknown", "src", "dest", "vendor/module"])
    assert.equal(workspaceDropDestination(source, "session:1", folder, inventory), undefined);
  assert.equal(workspaceDropDestination({ ...source, path: "removed/old.ts" }, "session:1", "empty", inventory), undefined);
});

test("file rows target their containing folder for dragged files, folders and mixed selections", () => {
  const folder = workspaceDropFolder("occupied/src/child.ts", false);
  const drop = (path: string, target: string) => workspaceDropDestination({ path, scope: "session:1" }, "session:1", target, inventory);
  assert.equal(drop("src/file.ts", folder), "occupied/src/file.ts");
  assert.equal(drop("src", folder), "occupied/src/src");
  assert.deepEqual(planFolderMove(["src/file.ts", "empty"], folder, inventory), [
    { path: "src/file.ts", destination: "occupied/src/file.ts" },
    { path: "empty", destination: "occupied/src/empty" },
  ]);
  assert.equal(drop("src/nested", workspaceDropFolder("README.md", false)), "nested");
  assert.equal(drop("src", workspaceDropFolder("empty", true)), "empty/src");
  assert.equal(drop("src", workspaceDropFolder("src/nested/child.ts", false)), undefined);
  assert.equal(drop("src/file.ts", workspaceDropFolder("dest/file.ts", false)), undefined);
});

const entry: WorkspaceEntry = {
  sessionId: "session", sessionGeneration: 1, path: "src/file.ts", absolutePath: "/workspace/src/file.ts",
  kind: "file", entries: 1, version: "a".repeat(64), text: "original",
};
const request = { path: "src", destination: "empty/src", sessionId: "session", generation: 1 };

function fixture() {
  const drafts = new WorkspaceDraftStore();
  const inspections: unknown[] = [];
  const mutations: WorkspaceMutation[] = [];
  const runtime = {
    async workspaceEntry(path: string, sessionId: string, generation: number) {
      inspections.push([path, sessionId, generation]);
      return { ...entry, path, kind: "directory" as const };
    },
    async mutateWorkspace(mutation: WorkspaceMutation, sessionId: string, generation: number) {
      assert.equal(sessionId, request.sessionId);
      assert.equal(generation, request.generation);
      mutations.push(mutation);
    },
  };
  return { drafts, inspections, mutations, runtime };
}

test("drop moves inspect the source while dialog moves retain their original optimistic version", async () => {
  const f = fixture();
  const moved = await moveWorkspaceEntry(request, f.runtime, f.drafts);
  assert.deepEqual(f.inspections, [["src", "session", 1]]);
  assert.deepEqual(moved, { action: "move", path: "src", destination: "empty/src", expectedVersion: entry.version });
  assert.deepEqual(f.mutations, [moved]);
  const expectedVersion = "b".repeat(64);
  const dialogMove = await moveWorkspaceEntry({ ...request, expectedVersion }, f.runtime, f.drafts);
  assert.equal(dialogMove.expectedVersion, expectedVersion);
  assert.equal(f.inspections.length, 1);
});

test("moves block dirty source descendants and saving destination drafts, including edits during inspection", async () => {
  const f = fixture();
  f.drafts.open(entry);
  f.drafts.change("session", entry.path, "unsaved");
  await assert.rejects(moveWorkspaceEntry(request, f.runtime, f.drafts), /affected drafts/);
  assert.equal(f.inspections.length, 0);
  f.drafts.change("session", entry.path, "original");
  const destination = { ...entry, path: "empty/src/file.ts" };
  f.drafts.open(destination);
  f.drafts.saving("session", destination.path, true);
  await assert.rejects(moveWorkspaceEntry(request, f.runtime, f.drafts), /destination drafts/);
  f.drafts.saving("session", destination.path, false);
  f.runtime.workspaceEntry = async () => {
    f.drafts.change("session", entry.path, "typed during lookup");
    return { ...entry, kind: "directory" };
  };
  await assert.rejects(moveWorkspaceEntry(request, f.runtime, f.drafts), /affected drafts/);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.drafts.get("session", entry.path)?.text, "typed during lookup");
});

test("failed inspection or mutation never reports a completed move or discards drafts", async () => {
  const f = fixture();
  f.drafts.open(entry);
  f.runtime.workspaceEntry = async () => { throw new Error("Entry belongs to a previous session."); };
  await assert.rejects(moveWorkspaceEntry(request, f.runtime, f.drafts), /previous session/);
  assert.equal(f.mutations.length, 0);
  f.runtime.mutateWorkspace = async () => { throw new Error("Destination already exists."); };
  await assert.rejects(moveWorkspaceEntry({ ...request, expectedVersion: entry.version }, f.runtime, f.drafts), /already exists/);
  assert.equal(f.drafts.get("session", entry.path)?.text, "original");
});
