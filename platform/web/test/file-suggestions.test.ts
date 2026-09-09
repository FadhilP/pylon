import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

test("file suggestions include initialized registered submodules and degrade uninitialized ones to folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-submodule-files-"));
  const childOrigin = await mkdtemp(join(tmpdir(), "pylon-submodule-child-"));
  const nestedOrigin = await mkdtemp(join(tmpdir(), "pylon-submodule-nested-"));
  const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, windowsHide: true });
  const initialize = async (cwd: string) => {
    await git(cwd, "init", "--quiet");
    await git(cwd, "config", "user.email", "suggestions@test.local");
    await git(cwd, "config", "user.name", "Suggestions Test");
  };
  try {
    await initialize(nestedOrigin);
    await writeFile(join(nestedOrigin, "nested-file.ts"), "nested\n");
    await git(nestedOrigin, "add", "nested-file.ts");
    await git(nestedOrigin, "commit", "--quiet", "-m", "nested");

    await initialize(childOrigin);
    await writeFile(join(childOrigin, ".gitignore"), "ignored.log\ntracked.log\n");
    await writeFile(join(childOrigin, "tracked-child.ts"), "tracked\n");
    await writeFile(join(childOrigin, "tracked.log"), "tracked despite ignore\n");
    await git(childOrigin, "add", ".gitignore", "tracked-child.ts");
    await git(childOrigin, "add", "--force", "tracked.log");
    await git(childOrigin, "commit", "--quiet", "-m", "child");
    await git(
      childOrigin,
      "-c", "protocol.file.allow=always",
      "submodule", "add", "--quiet", nestedOrigin.replaceAll("\\", "/"), "nested/module",
    );
    await git(childOrigin, "commit", "--quiet", "-m", "nested submodule");

    await initialize(root);
    await git(
      root,
      "-c", "protocol.file.allow=always",
      "submodule", "add", "--quiet", childOrigin.replaceAll("\\", "/"), "vendor/lib",
    );
    await git(root, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
    await writeFile(join(root, "vendor", "lib", "visible-child.ts"), "visible\n");
    await writeFile(join(root, "vendor", "lib", "ignored.log"), "ignored\n");

    assert.deepEqual((await suggestGitFiles(root, "tracked-child")).paths, ["vendor/lib/tracked-child.ts"]);
    assert.deepEqual((await suggestGitFiles(root, "visible-child")).paths, ["vendor/lib/visible-child.ts"]);
    assert.deepEqual((await suggestGitFiles(root, "tracked.log")).paths, ["vendor/lib/tracked.log"]);
    assert.deepEqual((await suggestGitFiles(root, "ignored.log")).paths, []);
    assert.deepEqual((await suggestGitFiles(root, "nested-file")).paths, [
      "vendor/lib/nested/module/nested-file.ts",
    ]);
    const initialized = (await suggestGitFiles(root, "vendor/lib", 20)).paths;
    assert.ok(initialized.includes("vendor/lib/"));
    assert.ok(!initialized.includes("vendor/lib"));

    await git(root, "submodule", "deinit", "--force", "--", "vendor/lib");
    invalidateFileSuggestions(root);
    assert.deepEqual(await suggestGitFiles(root, "vendor/lib", 20), {
      available: true,
      paths: ["vendor/lib/"],
    });
    assert.deepEqual((await suggestGitFiles(root, "tracked-child")).paths, []);
  } finally {
    invalidateFileSuggestions(root);
    await Promise.all([root, childOrigin, nestedOrigin].map(path => rm(path, { recursive: true, force: true })));
  }
});

test("file suggestions discover initialized index gitlinks without .gitmodules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-gitlink-files-"));
  const child = join(root, "vendor", "child");
  const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, windowsHide: true });
  try {
    await git(root, "init", "--quiet");
    await mkdir(child, { recursive: true });
    await git(child, "init", "--quiet");
    await git(child, "config", "user.email", "suggestions@test.local");
    await git(child, "config", "user.name", "Suggestions Test");
    await writeFile(join(child, "child-file.ts"), "child\n");
    await git(child, "add", "child-file.ts");
    await git(child, "commit", "--quiet", "-m", "child");
    await git(root, "add", "vendor/child");
    await assert.rejects(access(join(root, ".gitmodules")));

    assert.deepEqual((await suggestGitFiles(root, "child-file")).paths, ["vendor/child/child-file.ts"]);
  } finally {
    invalidateFileSuggestions(root);
    await rm(root, { recursive: true, force: true });
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
      if (args[0] !== "git" || args[1]?.[0] !== "ls-files" || !args[1]?.includes("--others") || args[2]?.cwd !== root) return (original as any)(...args);
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
