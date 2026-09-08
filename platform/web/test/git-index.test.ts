import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitIndexText } from "../src/server/workspace/git-index.ts";
import { readWorkspaceEntry } from "../src/server/workspace/workspace-mutations.ts";
import { WorkspaceDraftStore } from "../src/client/workspace/workspace-edit-state.ts";

const run = promisify(execFile);

test("index comparison refreshes after staging/unstaging without rebasing a dirty draft", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-git-gutter-"));
  const path = "nested/odd [name].ts";
  const file = join(cwd, path);
  const git = (...args: string[]) => run("git", args, { cwd });
  try {
    assert.equal(await readGitIndexText(cwd, path), undefined);
    await git("init");
    await git("config", "core.autocrlf", "false");
    await mkdir(join(cwd, "nested"));
    await writeFile(file, "\ufefforiginal\r\n");
    await git("--literal-pathspecs", "add", "--", path);
    const entry = { ...(await readWorkspaceEntry(cwd, path)), sessionId: "test", sessionGeneration: 1 };
    assert.equal(entry.gitIndexText, "original\n");
    assert.equal(await readGitIndexText(join(cwd, "nested"), "odd [name].ts"), "original\n");
    const drafts = new WorkspaceDraftStore();
    drafts.open(entry, true);
    drafts.change("test", path, "my unsaved draft\n");
    await writeFile(file, "external\n");
    assert.equal((await readWorkspaceEntry(cwd, path)).gitIndexText, "original\n");
    await git("--literal-pathspecs", "add", "--", path);
    const refreshed = { ...(await readWorkspaceEntry(cwd, path)), sessionId: "test", sessionGeneration: 1 };
    assert.equal(refreshed.gitIndexText, "external\n");
    assert.notEqual(refreshed.version, entry.version);
    drafts.open(refreshed, true);
    assert.equal(drafts.get("test", path)?.text, "my unsaved draft\n");
    assert.equal(drafts.get("test", path)?.version, entry.version);
    drafts.saving("test", path, true);
    drafts.open(refreshed, true);
    assert.equal(drafts.get("test", path)?.version, entry.version);
    assert.equal(drafts.get("test", path)?.saving, true);
    await git("--literal-pathspecs", "rm", "--cached", "--", path);
    assert.equal((await readWorkspaceEntry(cwd, path)).gitIndexText, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ignored, filtered, nonregular, conflicted and unsupported index blobs never masquerade as empty baselines", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-git-gutter-"));
  const git = (...args: string[]) => run("git", args, { cwd });
  try {
    await git("init");
    await git("config", "core.autocrlf", "false");
    await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
    await writeFile(join(cwd, "ignored.txt"), "ignored");
    assert.equal(await readGitIndexText(cwd, "ignored.txt"), undefined);
    await writeFile(join(cwd, "untracked.txt"), "new");
    assert.equal(await readGitIndexText(cwd, "untracked.txt"), "");
    await git("add", "-N", "untracked.txt");
    assert.equal(await readGitIndexText(cwd, "untracked.txt"), "");
    for (const [path, content] of [
      ["binary.txt", Buffer.from([65, 0, 66])],
      ["invalid.txt", Buffer.from([0xff])],
      ["large.txt", Buffer.alloc(1024 * 1024 + 1, 65)],
      ["filtered.txt", Buffer.from("original")],
    ] as const) {
      await writeFile(join(cwd, path), content);
      await git("add", "--", path);
      await writeFile(join(cwd, path), "editable now");
    }
    await writeFile(join(cwd, ".gitattributes"), "filtered.txt filter=custom\n");
    for (const path of ["binary.txt", "invalid.txt", "large.txt", "filtered.txt"]) {
      const entry = await readWorkspaceEntry(cwd, path);
      assert.equal(entry.text, "editable now");
      assert.equal(entry.gitIndexText, undefined);
    }
    const oid = (await git("rev-parse", ":filtered.txt")).stdout.trim();
    await writeFile(join(cwd, "link.txt"), "regular working file");
    await git("update-index", "--add", "--cacheinfo", `120000,${oid},link.txt`);
    assert.equal(await readGitIndexText(cwd, "link.txt"), undefined);
    await new Promise<void>((resolve, reject) => {
      const child = execFile("git", ["update-index", "--index-info"], { cwd }, error =>
        error ? reject(error) : resolve(),
      );
      child.stdin!.end(`100644 ${oid} 1\tconflicted.txt\n100644 ${oid} 2\tconflicted.txt\n`);
    });
    assert.equal(await readGitIndexText(cwd, "conflicted.txt"), undefined);
    assert.equal(await readGitIndexText(cwd, "../outside.txt"), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
