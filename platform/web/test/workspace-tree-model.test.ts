import assert from "node:assert/strict";
import test from "node:test";
import {
  ancestors,
  buildWorkspaceTree,
  deriveWorkspaceTree,
  subsequenceMatch,
  type WorkspaceTreeNode,
} from "../src/client/workspace/workspace-tree-model.ts";
import type { WorkspaceFileReadModel } from "../src/shared/protocol/snapshots.ts";
import { selectWorkspacePaths } from "../src/client/workspace/workspace-selection.ts";

const files: WorkspaceFileReadModel[] = [
  { path: "src/client/files-panel.tsx", status: "modified", additions: 35, deletions: 96 },
  { path: "src/client/App.tsx" },
  { path: "src/shared/file-icon.ts", status: "added", additions: 23, deletions: 0 },
  { path: "README.md" },
  { path: "vendor/pi", kind: "submodule" },
];

const child = (node: WorkspaceTreeNode, name: string) => node.children.find(entry => entry.name === name)!;

test("builds a directory tree with folders first and files sorted", () => {
  const root = buildWorkspaceTree(files);
  assert.deepEqual(
    root.children.map(node => node.name),
    ["src", "vendor", "README.md"],
  );
  assert.deepEqual(
    child(root, "src").children.map(node => node.name),
    ["client", "shared"],
  );
  assert.deepEqual(
    child(child(root, "src"), "client").children.map(node => node.name),
    ["App.tsx", "files-panel.tsx"],
  );
});

test("rolls subtree totals up into every ancestor", () => {
  const root = buildWorkspaceTree(files);
  const src = child(root, "src");
  assert.equal(src.additions, 58);
  assert.equal(src.deletions, 96);
  assert.equal(src.changedCount, 2);
  assert.equal(child(src, "client").changedCount, 1);
});

test("keeps submodules as directory chains with no selectable file", () => {
  const vendor = child(buildWorkspaceTree(files), "vendor");
  assert.equal(vendor.directory, true);
  assert.deepEqual(
    vendor.children.map(node => node.name),
    ["pi"],
  );
  assert.equal(child(vendor, "pi").children.length, 0);
  assert.equal(child(vendor, "pi").file, undefined);
});

test("matches on subsequence, not substring", () => {
  assert.equal(subsequenceMatch("fic", "src/shared/file-icon.ts"), true);
  assert.equal(subsequenceMatch("cif", "src/shared/file-icon.ts"), false);
  assert.equal(subsequenceMatch("", "anything"), true);
});

test("names every folder on the way to a file, outermost first", () => {
  assert.deepEqual(ancestors("platform/web/src/client/App.tsx"), [
    "platform",
    "platform/web",
    "platform/web/src",
    "platform/web/src/client",
  ]);
  assert.deepEqual(ancestors("README.md"), []);
});

test("filtered tree derivations drop hidden selections without mutating remembered expansion", () => {
  const root = buildWorkspaceTree(files);
  const stored = new Set(["src", "src/client", "src/shared"]);
  const all = deriveWorkspaceTree(root, files, "", stored, false);
  const selected = ["src/client/App.tsx", "src/client/files-panel.tsx"];
  for (const [query, changesOnly] of [["file", false], ["", true]] as const) {
    const filtered = deriveWorkspaceTree(root, files, query, stored, changesOnly);
    const expanded = deriveWorkspaceTree(root, files, query, filtered.expandable(stored), changesOnly);
    const selection = selectWorkspacePaths(selected, selected[1], "src/shared/file-icon.ts", expanded.visiblePaths, { toggle: true, range: true });
    assert.ok(!selection.paths.includes(selected[0]));
    assert.ok(selection.paths.includes(selected[1]));
    assert.ok(selection.paths.includes("src/shared/file-icon.ts"));
  }
  assert.deepEqual([...stored], ["src", "src/client", "src/shared"]);
  assert.ok(all.rowByPath.has(selected[0]), "later filters must not modify a previous derivation");
});
