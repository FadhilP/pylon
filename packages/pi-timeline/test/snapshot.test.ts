import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeFingerprint } from "../src/snapshot.ts";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim()),
    ),
  );
}

async function initializeRepository(root: string, file = "tracked.txt") {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "timeline@test.local"]);
  await git(root, ["config", "user.name", "timeline-test"]);
  await writeFile(join(root, file), "base\n");
  await git(root, ["add", file]);
  await git(root, ["commit", "-qm", "base"]);
}

test("fingerprints use HEAD trees for clean nested siblings when another repository is dirty", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-timeline-fingerprint-"));
  const child = join(root, "child");
  try {
    await initializeRepository(root);
    await mkdir(child);
    await initializeRepository(child, "child.txt");
    const childTree = await git(child, ["rev-parse", "HEAD^{tree}"]);
    const original = childProcess.execFile;
    const childCommands: string[][] = [];
    const rootAdds: string[][] = [];
    const mock = t.mock.method(childProcess, "execFile", ((...args: any[]) => {
      if (args[0] === "git" && args[2]?.cwd === child) childCommands.push(args[1]);
      if (args[0] === "git" && args[2]?.cwd === root && args[1]?.[0] === "add") rootAdds.push(args[1]);
      return (original as any)(...args);
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });

    const value = await worktreeFingerprint(root);
    assert.ok(value);
    const fingerprint = value!;
    assert.ok(rootAdds.length > 0, "the dirty parent still constructs its worktree tree");
    assert.equal(childCommands.some(args => args[0] === "add" || args[0] === "read-tree"), false);
    assert.equal(
      fingerprint.split("\n").filter(value => value === childTree).length,
      2,
      "the clean child contributes identical HEAD index and worktree identities",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
