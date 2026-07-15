import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorktree, compareWorktrees, parsePorcelainZ } from "../src/worktree.ts";

test("porcelain parser handles ordinary and renamed paths", () => {
  assert.deepEqual(parsePorcelainZ(" M a file.ts\0R  new.ts\0old.ts\0?? fresh.ts\0"), ["a file.ts", "fresh.ts", "new.ts", "old.ts"]);
});

test("worktree comparison detects new files and touched pre-existing dirty files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grunt-worktree-"));
  await writeFile(join(cwd, "dirty.txt"), "before");
  let status = " M dirty.txt\0";
  const exec = async (_command: string, args: string[]) => {
    if (args.includes("--show-toplevel")) return { code: 0, stdout: `${cwd}\n`, stderr: "" };
    if (args.at(-1) === "HEAD") return { code: 0, stdout: "deadbeef\n", stderr: "" };
    return { code: 0, stdout: status, stderr: "" };
  };
  const before = await captureWorktree(exec, cwd);
  await writeFile(join(cwd, "dirty.txt"), "after");
  await writeFile(join(cwd, "new.txt"), "new");
  status = " M dirty.txt\0?? new.txt\0";
  const after = await captureWorktree(exec, cwd);
  const result = await compareWorktrees(before, after, cwd);
  assert.deepEqual(result.changedPaths, ["dirty.txt", "new.txt"]);
  assert.deepEqual(result.preExistingDirtyTouched, ["dirty.txt"]);
});
