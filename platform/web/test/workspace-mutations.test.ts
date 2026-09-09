import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mutateWorkspace, readWorkspaceEntry } from "../src/server/workspace/workspace-mutations.ts";
import { collectPlainWorkspaceFiles, collectWorkspaceFiles } from "pylon-core/src/worktree.ts";
import { WorkspaceDraftStore } from "../src/client/workspace/workspace-edit-state.ts";
import { openFileTab, openRequestedFile, closeFileTab, selectFileTab, closeChangedFileTabs, reconcileFileTabs, workspaceStateForSession } from "../src/client/workspace/file-workspace-state.ts";

const run = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pylon-file-editor-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("saves preserve UTF-8 BOM, CRLF, final newline and mode; stale saves retain external edits", async () => {
  const f = await fixture();
  try {
    const path = join(f.cwd, "test.txt");
    await writeFile(path, "\ufeffhello\r\nworld");
    if (process.platform !== "win32") await chmod(path, 0o640);
    let acl: string | undefined;
    const powershell = (script: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`],
      { env: { ...process.env, PYLON_TEST_FILE: path }, windowsHide: true });
    if (process.platform === "win32") {
      acl = (await powershell("$acl = Get-Acl -LiteralPath $env:PYLON_TEST_FILE; $acl.SetAccessRuleProtection($true, $true); Set-Acl -LiteralPath $env:PYLON_TEST_FILE -AclObject $acl; (Get-Acl -LiteralPath $env:PYLON_TEST_FILE).Sddl")).stdout.trim();
    }
    const before = await lstat(path);
    const entry = await readWorkspaceEntry(f.cwd, "test.txt");
    assert.equal(entry.text, "hello\nworld");
    const receipt = await mutateWorkspace(f.cwd, { action: "save", path: "test.txt", expectedVersion: entry.version, text: "hello\nchanged" });
    assert.deepEqual(await readFile(path), Buffer.from("\ufeffhello\r\nchanged"));
    assert.equal((await lstat(path)).mode & 0o777, before.mode & 0o777);
    if (acl) assert.equal((await powershell("(Get-Acl -LiteralPath $env:PYLON_TEST_FILE).Sddl")).stdout.trim(), acl);
    const fresh = await readWorkspaceEntry(f.cwd, "test.txt");
    assert.equal(receipt?.savedVersion, fresh.version, "receipt confirms the metadata-preserving saved bytes");
    const second = await mutateWorkspace(f.cwd, { action: "save", path: "test.txt", expectedVersion: receipt!.savedVersion, text: "second save" });
    assert.equal((await readWorkspaceEntry(f.cwd, "test.txt")).version, second?.savedVersion);
    await writeFile(path, "external\r\n");
    await assert.rejects(mutateWorkspace(f.cwd, { action: "save", path: "test.txt", expectedVersion: fresh.version, text: "lost" }), /changed on disk/);
    assert.equal(await readFile(path, "utf8"), "external\r\n");
    assert.deepEqual(await readdir(f.cwd), ["test.txt"]);
  } finally { await f.cleanup(); }
});

test("create, move and delete are bounded, reject collisions and protect changed folder contents", async () => {
  const f = await fixture();
  try {
    await mutateWorkspace(f.cwd, { action: "createDirectory", path: "empty" });
    await mutateWorkspace(f.cwd, { action: "createFile", path: "empty/a.txt" });
    await writeFile(join(f.cwd, "empty/a.txt"), "keep");
    await assert.rejects(mutateWorkspace(f.cwd, { action: "createFile", path: "empty/a.txt" }), /EEXIST/);
    const file = await readWorkspaceEntry(f.cwd, "empty/a.txt");
    await mutateWorkspace(f.cwd, { action: "move", path: "empty/a.txt", destination: "empty/b.txt", expectedVersion: file.version });
    assert.deepEqual(await readdir(join(f.cwd, "empty")), ["b.txt"]);
    const folder = await readWorkspaceEntry(f.cwd, "empty");
    await assert.rejects(mutateWorkspace(f.cwd, { action: "move", path: "empty", destination: "empty/child", expectedVersion: folder.version }), /into itself/);
    await mkdir(join(f.cwd, "occupied"));
    await assert.rejects(mutateWorkspace(f.cwd, { action: "move", path: "empty", destination: "occupied", expectedVersion: folder.version }), /already exists/);
    await mutateWorkspace(f.cwd, { action: "move", path: "empty", destination: "renamed", expectedVersion: folder.version });
    const renamed = await readWorkspaceEntry(f.cwd, "renamed");
    await writeFile(join(f.cwd, "renamed/b.txt"), "external");
    await assert.rejects(mutateWorkspace(f.cwd, { action: "delete", path: "renamed", expectedVersion: renamed.version, confirmed: true }), /changed on disk/);
    assert.equal(await readFile(join(f.cwd, "renamed/b.txt"), "utf8"), "external");
    const current = await readWorkspaceEntry(f.cwd, "renamed");
    await mutateWorkspace(f.cwd, { action: "delete", path: "renamed", expectedVersion: current.version, confirmed: true });
    assert.deepEqual(await readdir(f.cwd), ["occupied"]);
  } finally { await f.cleanup(); }
});

test("copy snapshots files and folders without merging or overwriting", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.cwd, "source/empty"), { recursive: true });
    await writeFile(join(f.cwd, "source/text.txt"), "copy me");
    await writeFile(join(f.cwd, "source/binary.bin"), Buffer.from([0, 1, 2, 255]));
    const source = await readWorkspaceEntry(f.cwd, "source");
    assert.equal(source.absolutePath, join(f.cwd, "source"));
    await mutateWorkspace(f.cwd, { action: "copy", path: source.path, destination: "copied", expectedVersion: source.version });
    assert.equal(await readFile(join(f.cwd, "copied/text.txt"), "utf8"), "copy me");
    assert.deepEqual(await readFile(join(f.cwd, "copied/binary.bin")), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(await readdir(join(f.cwd, "copied")), ["binary.bin", "empty", "text.txt"]);
    await assert.rejects(
      mutateWorkspace(f.cwd, { action: "copy", path: source.path, destination: "copied", expectedVersion: source.version }),
      /already exists/,
    );
    await assert.rejects(
      mutateWorkspace(f.cwd, { action: "copy", path: source.path, destination: "source/child", expectedVersion: source.version }),
      /into itself/,
    );
    const text = await readWorkspaceEntry(f.cwd, "source/text.txt");
    await writeFile(join(f.cwd, "source/text.txt"), "changed");
    await assert.rejects(
      mutateWorkspace(f.cwd, { action: "copy", path: text.path, destination: "stale.txt", expectedVersion: text.version }),
      /changed on disk/,
    );
    await assert.rejects(readFile(join(f.cwd, "stale.txt")), /ENOENT/);
  } finally { await f.cleanup(); }
});

test("filesystem mutations reject escapes, symlinks, metadata, nested repositories and wrong workspace versions", async () => {
  const f = await fixture();
  try {
    for (const path of ["../escape", "/absolute", "a/../escape", "a\\b", ".git/config", ".gitmodules", "file:stream", "CON", "alias.", "alias "])
      await assert.rejects(mutateWorkspace(f.cwd, { action: "createFile", path }), /Invalid/);
    await mkdir(join(f.root, "outside"));
    await symlink(join(f.root, "outside"), join(f.cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(mutateWorkspace(f.cwd, { action: "createFile", path: "linked/escape" }), /Symlinks/);
    assert.deepEqual(await readdir(join(f.root, "outside")), []);
    await mkdir(join(f.cwd, "nested/.git"), { recursive: true });
    await assert.rejects(readWorkspaceEntry(f.cwd, "nested"), /Nested repositories/);
    await mkdir(join(f.cwd, "module"));
    await writeFile(join(f.cwd, ".gitmodules"), '[submodule "module"]\n path = module\n url = local\n');
    await assert.rejects(mutateWorkspace(f.cwd, { action: "createFile", path: "module/test" }), /submodules/);
    await writeFile(join(f.cwd, "test.txt"), "same");
    await writeFile(join(f.root, "outside/test.txt"), "same");
    const entry = await readWorkspaceEntry(f.cwd, "test.txt");
    await assert.rejects(mutateWorkspace(join(f.root, "outside"), { action: "save", path: "test.txt", expectedVersion: entry.version, text: "wrong" }), /changed on disk/);
    assert.equal(await readFile(join(f.root, "outside/test.txt"), "utf8"), "same");
  } finally { await f.cleanup(); }
});

test("unsupported encodings and malformed submitted text cannot silently corrupt files", async () => {
  const f = await fixture();
  try {
    for (const bytes of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.from("a\r\nb\n"), Buffer.from("a\rb"), Buffer.from("a\0b"), Buffer.alloc(1024 * 1024 + 1, 97)]) {
      await writeFile(join(f.cwd, "test"), bytes);
      const entry = await readWorkspaceEntry(f.cwd, "test");
      assert.equal(entry.text, undefined);
      await assert.rejects(mutateWorkspace(f.cwd, { action: "save", path: "test", expectedVersion: entry.version, text: "replacement" }));
      assert.deepEqual(await readFile(join(f.cwd, "test")), bytes);
    }
    await writeFile(join(f.cwd, "test"), "valid");
    const entry = await readWorkspaceEntry(f.cwd, "test");
    for (const text of ["\ud800", "\0", "\r", "é".repeat(1024 * 1024)])
      await assert.rejects(mutateWorkspace(f.cwd, { action: "save", path: "test", expectedVersion: entry.version, text }));
    assert.equal(await readFile(join(f.cwd, "test"), "utf8"), "valid");
  } finally { await f.cleanup(); }
});

test("empty nested directories survive fresh plain and Git inventories without exposing ignored trees", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.cwd, "empty/nested"), { recursive: true });
    const plain = await collectPlainWorkspaceFiles({ cwd: f.cwd });
    assert.deepEqual(plain.files, [{ path: "empty", kind: "directory" }, { path: "empty/nested", kind: "directory" }]);
    await run("git", ["init"], { cwd: f.cwd });
    await writeFile(join(f.cwd, ".gitignore"), "ignored/\n");
    await mkdir(join(f.cwd, "ignored/secret"), { recursive: true });
    const git = await collectWorkspaceFiles({ cwd: f.cwd });
    assert.ok(git.files.some(file => file.path === "empty/nested" && file.kind === "directory"));
    assert.ok(!git.files.some(file => file.path.startsWith("ignored")));
  } finally { await f.cleanup(); }
});

test("drafts retain original versions across refreshes, protect in-flight saves and reconcile descendant tabs", () => {
  const drafts = new WorkspaceDraftStore();
  const entry = { sessionId: "one", sessionGeneration: 1, path: "folder/a", version: "original", kind: "file" as const, entries: 1, text: "base" };
  drafts.open(entry);
  drafts.change("one", "folder/a", "draft");
  drafts.open({ ...entry, version: "external", text: "external" });
  drafts.open({ ...entry, sessionId: "two" });
  assert.equal(drafts.get("one", "folder/a")?.version, "original");
  assert.equal(drafts.get("one", "folder/a")?.text, "draft");
  assert.equal(drafts.get("two", "folder/a")?.text, "base");
  assert.throws(() => drafts.removeUnder("one", "folder"), /Save or discard/);
  drafts.saving("one", "folder/a", true);
  assert.throws(() => drafts.remove("one", "folder/a"), /Wait/);
  drafts.change("one", "folder/a", "lost");
  assert.equal(drafts.get("one", "folder/a")?.text, "draft");
  drafts.saving("one", "folder/a", false);
  drafts.remove("one", "folder/a");
  assert.equal(drafts.dirty(), false);
  let state = workspaceStateForSession(new Map(), "one");
  state = openFileTab(state, "folder/a", "current");
  state = openFileTab(state, "folder/b", "diff");
  state = reconcileFileTabs(state, "folder", "moved");
  assert.deepEqual(state.openPaths, ["moved/a", "moved/b"]);
  assert.equal(state.selectedPath, "moved/b");
  assert.equal(state.views["moved/b"], "diff");
  assert.deepEqual(reconcileFileTabs(state, "moved").openPaths, []);
});

test("direct editor refreshes clean buffers but never rebases or evicts unsaved and saving drafts", () => {
  const drafts = new WorkspaceDraftStore();
  const entry = { sessionId: "one", sessionGeneration: 1, path: "clean", version: "v1", kind: "file" as const, entries: 1, text: "base" };
  drafts.open(entry, true);
  drafts.open({ ...entry, version: "v2", text: "external" }, true);
  assert.equal(drafts.get("one", "clean")?.text, "external");
  assert.equal(drafts.get("one", "clean")?.version, "v2");
  drafts.change("one", "clean", "my draft");
  drafts.open({ ...entry, version: "v3", text: "another edit" }, true);
  assert.equal(drafts.get("one", "clean")?.text, "my draft");
  assert.equal(drafts.get("one", "clean")?.version, "v2");
  drafts.open({ ...entry, path: "saving" }, true);
  drafts.saving("one", "saving", true);
  drafts.open({ ...entry, path: "saving", version: "v4" }, true);
  assert.equal(drafts.get("one", "saving")?.version, "v1");
  assert.equal(drafts.get("one", "saving")?.saving, true);
  for (let index = 0; index < 50; index++) drafts.open({ ...entry, path: `viewed-${index}` }, true);
  assert.equal(drafts.get("one", "clean")?.text, "my draft");
  assert.equal(drafts.get("one", "saving")?.saving, true);
  assert.equal(drafts.get("one", "viewed-49")?.text, "base");
  drafts.saving("one", "clean", true);
  drafts.acceptSave("one", "clean", "saved-version", drafts.get("one", "clean")!);
  assert.equal(drafts.get("one", "clean")?.text, "my draft");
  assert.equal(drafts.get("one", "clean")?.original, "my draft");
  assert.equal(drafts.dirty("one", "clean"), false);
  drafts.open({ ...entry, text: "my draft", version: "saved-version" }, true);
  assert.equal(drafts.get("one", "clean")?.version, "saved-version");
});

test("draft notifications are file-scoped and save acknowledgements cannot accept a different submission", () => {
  const drafts = new WorkspaceDraftStore();
  const entry = { sessionId: "one", sessionGeneration: 1, path: "a", version: "v1", kind: "file" as const, entries: 1, text: "base" };
  drafts.open(entry);
  drafts.open({ ...entry, path: "b" });
  let chrome = 0, a = 0, b = 0;
  drafts.subscribe(() => chrome++);
  const unsubscribe = drafts.subscribeFile("one", "a", () => a++);
  drafts.subscribeFile("one", "b", () => b++);
  drafts.change("one", "a", "first");
  drafts.change("one", "a", "second");
  drafts.change("one", "a", "third");
  assert.deepEqual([chrome, a, b], [1, 3, 0]);
  const submitted = drafts.get("one", "a")!;
  drafts.saving("one", "a", true);
  drafts.acceptSave("one", "a", "", submitted);
  drafts.acceptSave("one", "a", "wrong", { ...submitted, text: "different" });
  assert.equal(drafts.get("one", "a")?.original, "base");
  drafts.acceptSave("one", "a", "v2", submitted);
  assert.equal(drafts.get("one", "a")?.version, "v2");
  assert.equal(drafts.dirty("one", "a"), false);
  drafts.change("one", "a", "later");
  drafts.acceptSave("one", "a", "v2", submitted);
  assert.equal(drafts.get("one", "a")?.original, "third");
  assert.equal(drafts.get("one", "a")?.text, "later");
  assert.equal(drafts.dirty("one", "a"), true);
  unsubscribe();
  const previous = a;
  drafts.change("one", "a", "another");
  assert.equal(a, previous);
});

test("explorer defaults to working copy while explicit Changes openings retain diff and tab selection", () => {
  let state = workspaceStateForSession(new Map(), "one");
  state = openFileTab(state, "modified.ts");
  assert.equal(state.view, "current");
  assert.deepEqual(state.changedPaths, []);
  state = openFileTab(state, "changed.ts", "diff", undefined, true);
  assert.equal(state.view, "diff");
  state = selectFileTab(state, "modified.ts");
  assert.equal(state.view, "current");
  state = selectFileTab(state, "changed.ts");
  assert.equal(state.view, "diff");
  assert.deepEqual(closeChangedFileTabs(state).openPaths, ["modified.ts"]);
  state = openFileTab(state, "changed.ts");
  assert.equal(state.view, "current", "reopening through explorer chooses working copy even for a changed file");
  assert.deepEqual(closeChangedFileTabs(state).openPaths, ["modified.ts", "changed.ts"]);
});


test("returning to a file surface preserves its last selection instead of replaying a consumed navigation request", () => {
  const states = new Map();
  const request = { sessionId: "one", path: "requested.ts", requestId: 1, line: 4 };
  let state = openRequestedFile(workspaceStateForSession(states, "one"), request);
  state = { ...openFileTab(state, "chosen.ts", "diff"), query: "chosen" };
  states.set("one", state);
  const remounted = workspaceStateForSession(states, "one");
  assert.equal(openRequestedFile(remounted, request), state);
  assert.equal(remounted.selectedPath, "chosen.ts");
  assert.equal(remounted.view, "diff");
  assert.equal(remounted.query, "chosen");
  const other = workspaceStateForSession(states, "two");
  assert.equal(openRequestedFile(other, request), other, "a request for another session must not open its path");
  const next = { ...request, requestId: 2 };
  state = openRequestedFile(remounted, next);
  assert.equal(state.selectedPath, "requested.ts");
  assert.equal(state.selectedLine, 4);
  state = closeFileTab(state, "requested.ts");
  assert.equal(openRequestedFile(state, next), state, "returning must not reopen a deliberately closed file");
  const inspector = openRequestedFile(workspaceStateForSession(new Map(), "one"), request);
  assert.equal(inspector.selectedPath, "requested.ts", "each surface consumes explicit navigation independently");
});
