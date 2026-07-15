import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  applyWorkerPatch, collectWorkerPatch, createIsolatedWorktree,
  parentChangesSinceBaseline, removeIsolatedWorktree,
} from "../src/isolation.ts";

const execFileAsync = promisify(execFile);
const exec = async (command: string, args: string[]) => {
  try {
    const result = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
};

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "grunt-isolation-test-"));
  await execFileAsync("git", ["init", root]);
  await writeFile(join(root, "tracked.txt"), "head\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  await execFileAsync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "base"]);
  return root;
}

test("isolated worktree includes dirty and untracked parent state then applies only worker delta", async () => {
  const root = await repository();
  await writeFile(join(root, "tracked.txt"), "parent dirty\n");
  await writeFile(join(root, "untracked.txt"), "parent untracked\n");
  const isolated = await createIsolatedWorktree(exec, root);
  try {
    assert.equal(isolated.isolationVerified, true);
    assert.notEqual(isolated.workerRoot, isolated.parentRoot);
    const top = await exec("git", ["-C", isolated.workerCwd, "rev-parse", "--show-toplevel"]);
    assert.equal(top.stdout.trim().replace(/\\/g, "/"), isolated.workerRoot.replace(/\\/g, "/"));
    assert.equal(await readFile(join(isolated.workerRoot, "tracked.txt"), "utf8"), "parent dirty\n");
    assert.equal(await readFile(join(isolated.workerRoot, "untracked.txt"), "utf8"), "parent untracked\n");

    await writeFile(join(isolated.workerRoot, "tracked.txt"), "worker result\n");
    await writeFile(join(isolated.workerRoot, "untracked.txt"), "worker untracked result\n");
    await mkdir(join(isolated.workerRoot, "src"));
    await writeFile(join(isolated.workerRoot, "src", "new.ts"), "export const value = 1;\n");

    const worker = await collectWorkerPatch(exec, isolated);
    assert.deepEqual(worker.changedPaths, ["src/new.ts", "tracked.txt", "untracked.txt"]);
    assert.deepEqual(await parentChangesSinceBaseline(exec, isolated), []);
    await applyWorkerPatch(exec, isolated, worker.patch);

    assert.equal((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "worker result\n");
    assert.equal((await readFile(join(root, "untracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "worker untracked result\n");
    assert.equal((await readFile(join(root, "src", "new.ts"), "utf8")).replace(/\r\n/g, "\n"), "export const value = 1;\n");
  } finally {
    await removeIsolatedWorktree(exec, isolated);
  }
});

test("baseline creation disables repository hooks", async () => {
  const root = await repository();
  const marker = join(root, "hook-ran.txt");
  for (const hook of ["post-checkout", "pre-commit"]) {
    const path = join(root, ".git", "hooks", hook);
    await writeFile(path, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\n`);
    await chmod(path, 0o755);
  }
  const isolated = await createIsolatedWorktree(exec, root);
  try {
    await assert.rejects(readFile(marker));
    assert.deepEqual((await collectWorkerPatch(exec, isolated)).changedPaths, []);
  } finally {
    await removeIsolatedWorktree(exec, isolated);
  }
});

test("worker commits remain part of the immutable-baseline patch", async () => {
  const root = await repository();
  const isolated = await createIsolatedWorktree(exec, root);
  try {
    await writeFile(join(isolated.workerRoot, "tracked.txt"), "committed worker result\n");
    await execFileAsync("git", ["-C", isolated.workerRoot, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", isolated.workerRoot, "-c", "user.name=test", "-c", "user.email=test@local", "commit", "--no-verify", "-m", "worker"]);
    const worker = await collectWorkerPatch(exec, isolated);
    assert.deepEqual(worker.changedPaths, ["tracked.txt"]);
    assert.match(worker.patch, /committed worker result/);
  } finally {
    await removeIsolatedWorktree(exec, isolated);
  }
});

test("same-repository isolation transactions wait for cleanup", async () => {
  const root = await repository();
  const first = await createIsolatedWorktree(exec, root);
  let secondReady = false;
  const secondPromise = createIsolatedWorktree(exec, root).then((value) => { secondReady = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondReady, false);
  await removeIsolatedWorktree(exec, first);
  const second = await secondPromise;
  await removeIsolatedWorktree(exec, second);
});

test("apply rechecks parent state immediately before integration", async () => {
  const root = await repository();
  const isolated = await createIsolatedWorktree(exec, root);
  try {
    await writeFile(join(isolated.workerRoot, "tracked.txt"), "worker\n");
    const worker = await collectWorkerPatch(exec, isolated);
    await writeFile(join(root, "tracked.txt"), "external\n");
    await assert.rejects(applyWorkerPatch(exec, isolated, worker.patch), /immediately before patch apply/);
  } finally {
    await removeIsolatedWorktree(exec, isolated);
  }
});

test("failed creation releases the repository transaction", async () => {
  const root = await repository();
  let fail = true;
  const failingExec = async (command: string, args: string[]) => {
    if (fail && args.includes("worktree") && args.includes("add")) {
      fail = false;
      return { code: 1, stdout: "", stderr: "injected" };
    }
    return exec(command, args);
  };
  await assert.rejects(createIsolatedWorktree(failingExec, root), /injected/);
  const isolated = await createIsolatedWorktree(exec, root);
  await removeIsolatedWorktree(exec, isolated);
});

test("cleanup reports failures without throwing and releases the transaction", async () => {
  const root = await repository();
  const isolated = await createIsolatedWorktree(exec, root);
  const failingExec = async (command: string, args: string[]) =>
    args.includes("remove") ? { code: 1, stdout: "", stderr: "busy" } : exec(command, args);
  assert.deepEqual(await removeIsolatedWorktree(failingExec, isolated), ["worktree cleanup: busy"]);
  const next = await createIsolatedWorktree(exec, root);
  await removeIsolatedWorktree(exec, next);
});

test("parent changes make isolated result stale", async () => {
  const root = await repository();
  const isolated = await createIsolatedWorktree(exec, root);
  try {
    await writeFile(join(root, "tracked.txt"), "external change\n");
    assert.deepEqual(await parentChangesSinceBaseline(exec, isolated), ["tracked.txt"]);
  } finally {
    await removeIsolatedWorktree(exec, isolated);
  }
});
