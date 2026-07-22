import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { preflight } from "../src/safety.ts";

const exec = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-timeline-test-"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.email", "timeline@test.local");
  await git("config", "user.name", "timeline-test");
  await writeFile(join(root, ".gitignore"), "ignored.log\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git("add", ".gitignore", "tracked.txt");
  await git("commit", "-qm", "base");
  return { root, git };
}

test("preflight refuses common untracked credential files", async () => {
  const { root } = await repository();
  try {
    await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=secret\n");
    await assert.rejects(preflight(root), /Unsafe untracked path: \.npmrc/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight scans initialized gitlinks without .gitmodules", async () => {
  const { root, git } = await repository(), child = join(root, "child");
  const childGit = async (...args: string[]) =>
    (await exec("git", args, { cwd: child, windowsHide: true })).stdout.trim();
  try {
    await mkdir(child);
    await childGit("init", "-q");
    await childGit("config", "user.email", "timeline@test.local");
    await childGit("config", "user.name", "timeline-test");
    await writeFile(join(child, "tracked.txt"), "child\n");
    await childGit("add", "tracked.txt");
    await childGit("commit", "-qm", "child");
    await assert.rejects(access(join(root, ".gitmodules")));
    await writeFile(join(child, ".npmrc"), "token=secret\n");
    await assert.rejects(preflight(root), /Unsafe untracked path: child\/\.npmrc/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
