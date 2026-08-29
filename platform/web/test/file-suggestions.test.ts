import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { suggestGitFiles } from "../src/server/pi/file-suggestions.ts";

const exec = promisify(execFile);

test("file suggestions include tracked and visible untracked files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-files-"));
  const nonGit = await mkdtemp(join(tmpdir(), "pylon-non-git-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "src", "tracked.ts"), "tracked\n", "utf8");
    await writeFile(join(root, "src", "untracked.ts"), "untracked\n", "utf8");
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        writeFile(
          join(root, "src", `extra-${String(index).padStart(2, "0")}.ts`),
          "extra\n",
          "utf8",
        ),
      ),
    );
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await exec("git", ["add", "src/tracked.ts"], {
      cwd: root,
      windowsHide: true,
    });
    await mkdir(join(root, "nested"));
    await exec("git", ["init", "--quiet"], {
      cwd: join(root, "nested"),
      windowsHide: true,
    });
    await writeFile(join(root, "nested", "inner-file.ts"), "inner\n", "utf8");
    await writeFile(join(root, "src", "tracked.ts"), "tracked\n", "utf8");
    await writeFile(join(root, "src", "untracked.ts"), "untracked\n", "utf8");
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        writeFile(
          join(root, "src", `extra-${String(index).padStart(2, "0")}.ts`),
          "extra\n",
          "utf8",
        ),
      ),
    );
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await exec("git", ["add", "src/tracked.ts"], {
      cwd: root,
      windowsHide: true,
    });

    const result = await suggestGitFiles(root, "track");
    assert.equal(result.available, true);
    assert.deepEqual(result.paths, ["src/tracked.ts", "src/untracked.ts"]);
    assert.equal((await suggestGitFiles(root, "")).paths.length, 15);
    assert.equal((await suggestGitFiles(root, "ignored")).paths.length, 0);
    assert.deepEqual(await suggestGitFiles(root, "inner-file"), {
      available: true,
      paths: ["nested/inner-file.ts"],
    });
    await mkdir(join(nonGit, "docs"));
    await writeFile(join(nonGit, "docs", "notes.md"), "notes\n", "utf8");
    const plain = await suggestGitFiles(nonGit, "note");
    assert.equal(plain.available, true);
    assert.deepEqual(plain.paths, ["docs/notes.md"]);
  } finally {
    await Promise.all(
      [root, nonGit].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});
