import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { invalidateFileSuggestions, suggestGitFiles } from "../src/server/workspace/file-suggestions.ts";

const exec = promisify(execFile);

test("file suggestions include tracked and visible untracked files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-files-"));
  const nonGit = await mkdtemp(join(tmpdir(), "pylon-non-git-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "ignored.txt\nignored/\n", "utf8");
    await writeFile(join(root, "src", "tracked.ts"), "tracked\n", "utf8");
    await writeFile(join(root, "src", "untracked.ts"), "untracked\n", "utf8");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "secret.ts"), "ignored\n", "utf8");
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        writeFile(join(root, "src", `extra-${String(index).padStart(2, "0")}.ts`), "extra\n", "utf8"),
      ),
    );
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await exec("git", ["add", "src/tracked.ts"], { cwd: root, windowsHide: true });
    await mkdir(join(root, "nested"));
    await exec("git", ["init", "--quiet"], { cwd: join(root, "nested"), windowsHide: true });
    await writeFile(join(root, "nested", "inner-file.ts"), "inner\n", "utf8");
    await writeFile(join(root, "src", "tracked.ts"), "tracked\n", "utf8");
    await writeFile(join(root, "src", "untracked.ts"), "untracked\n", "utf8");
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        writeFile(join(root, "src", `extra-${String(index).padStart(2, "0")}.ts`), "extra\n", "utf8"),
      ),
    );
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await exec("git", ["add", "src/tracked.ts"], { cwd: root, windowsHide: true });

    const result = await suggestGitFiles(root, "track");
    assert.equal(result.available, true);
    assert.deepEqual(result.paths, ["src/tracked.ts", "src/untracked.ts"]);
    assert.equal((await suggestGitFiles(root, "")).paths.length, 15);
    assert.equal((await suggestGitFiles(root, "ignored")).paths.length, 0);
    assert.deepEqual(await suggestGitFiles(root, "inner-file"), { available: true, paths: ["nested/inner-file.ts"] });
    assert.deepEqual(await suggestGitFiles(root, "nested"), {
      available: true,
      paths: ["nested/", "nested/inner-file.ts"],
    });
    assert.equal((await suggestGitFiles(root, "src")).paths.filter(path => path === "src/").length, 1);
    await mkdir(join(nonGit, "docs"));
    await writeFile(join(nonGit, "docs", "notes.md"), "notes\n", "utf8");
    const plain = await suggestGitFiles(nonGit, "docs");
    assert.equal(plain.available, true);
    assert.deepEqual(plain.paths, ["docs/", "docs/notes.md"]);
  } finally {
    await Promise.all([root, nonGit].map(path => rm(path, { recursive: true, force: true })));
  }
});

test("suggestion misses share work, invalidation retires old writers, and failed loads can retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "pylon-suggestion-flights-"));
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const requests: Promise<unknown>[] = [];
  try {
    await exec("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "old.ts"), "old");
    const original = childProcess.execFile;
    let calls = 0;
    let fail = false;
    const mock = t.mock.method(childProcess, "execFile", ((...args: any[]) => {
      if (args[0] !== "git" || args[1]?.[0] !== "ls-files" || args[2]?.cwd !== root) return (original as any)(...args);
      calls++;
      const callback = args.pop();
      if (fail) {
        queueMicrotask(() => callback(Object.assign(new Error("unavailable"), { code: "EACCES" }), "", ""));
        return {};
      }
      const hold = calls === 1;
      return (original as any)(...args, (...result: any[]) => {
        if (hold) { release = () => callback(...result); entered(); }
        else callback(...result);
      });
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    try {
      const first = suggestGitFiles(root, "old");
      const joined = suggestGitFiles(root, "");
      requests.push(first, joined);
      await ready;
      assert.equal(calls, 1);
      invalidateFileSuggestions(root);
      await writeFile(join(root, "new.ts"), "new");
      assert.deepEqual((await suggestGitFiles(root, "new")).paths, ["new.ts"]);
      release();
      await Promise.all([first, joined]);
      assert.deepEqual((await suggestGitFiles(root, "new")).paths, ["new.ts"]);
      assert.equal(calls, 2, "the old completion must not replace the newer cache");
      invalidateFileSuggestions(root);
      fail = true;
      await assert.rejects(suggestGitFiles(root, ""), /unavailable/);
      fail = false;
      assert.deepEqual((await suggestGitFiles(root, "new")).paths, ["new.ts"]);
      assert.equal(calls, 4);
    } finally { release?.(); await Promise.allSettled(requests); mock.mock.restore(); syncBuiltinESMExports(); }
  } finally { invalidateFileSuggestions(root); await rm(root, { recursive: true, force: true }); }
});
