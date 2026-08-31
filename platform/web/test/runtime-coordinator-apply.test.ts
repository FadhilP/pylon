import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RuntimeCoordinator } from "../src/server/pi/runtime-coordinator.ts";
import { projectIdForCwd } from "../src/server/pi/session-index.ts";

const run = promisify(execFile);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pylon-coordinator-apply-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  try {
    await rm(isolatedAgentDir, { recursive: true, force: true });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("session changes apply from a worktree and Project folder without committing", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-apply-session-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(cwd, "README.md"), "base\n");
  await run("git", ["init"], { cwd });
  await appendFile(join(cwd, ".git", "config"), "\n[user]\n\tname = Pylon Test\n\temail = pylon@test.local\n");
  await run("git", ["add", "README.md"], { cwd });
  await run("git", ["commit", "-m", "Initial"], { cwd });
  const originalBranch = (await run("git", ["branch", "--show-current"], { cwd })).stdout.trim();
  const driver = new RuntimeCoordinator();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const slot = (driver as any).selected();
    await (driver as any).ensureDraftWorkspace(slot);
    await (driver as any).moveSelectedFromLocal(slot, projectIdForCwd(cwd), "worktree");
    await writeFile(join(slot.driver.runtimeDetails().cwd, "README.md"), "base\nisolated\n");
    await writeFile(join(cwd, "local.txt"), "keep local\n");
    const worktreeSnapshot = await driver.snapshot();
    assert.equal(worktreeSnapshot.workspace?.mode, "worktree");
    await assert.rejects(
      driver.applySessionChanges({
        expectedGeneration: worktreeSnapshot.sessionGeneration,
        expectedRevision: "stale-revision",
      }),
      /session changes changed/,
    );
    assert.equal((await readFile(join(cwd, "README.md"), "utf8")).replaceAll("\r\n", "\n"), "base\n");
    const applied = await driver.applySessionChanges({
      expectedGeneration: worktreeSnapshot.sessionGeneration,
      expectedRevision: worktreeSnapshot.workspace!.revision!,
    });
    const [appliedReadme, localFile, appliedSnapshot, appliedStatus] = await Promise.all([
      readFile(join(cwd, "README.md"), "utf8"),
      readFile(join(cwd, "local.txt"), "utf8"),
      driver.snapshot(),
      run("git", ["status", "--porcelain"], { cwd }),
    ]);
    assert.equal(appliedReadme.replaceAll("\r\n", "\n"), "base\nisolated\n");
    assert.equal(localFile.trim(), "keep local");
    assert.equal(appliedSnapshot.workspace?.mode, "worktree");
    assert.equal(appliedStatus.stdout.includes("README.md"), true);

    const moved = await driver.handoffSession({
      destination: "checkout",
      expectedGeneration: applied.sessionGeneration,
    });
    await writeFile(join(cwd, "README.md"), "base\nisolated\nproject-folder\n");
    const checkoutSnapshot = await driver.snapshot();
    assert.equal(checkoutSnapshot.workspace?.mode, "checkout");
    const localized = await driver.applySessionChanges({
      expectedGeneration: moved.sessionGeneration,
      expectedRevision: checkoutSnapshot.workspace!.revision!,
    });
    const [localSnapshot, localFiles, readmeDiff, branch, finalReadme, latestCommit] = await Promise.all([
      driver.snapshot(),
      driver.workspaceFiles({}),
      driver.workspaceDiff({ path: "README.md" }),
      run("git", ["branch", "--show-current"], { cwd }),
      readFile(join(cwd, "README.md"), "utf8"),
      run("git", ["log", "-1", "--pretty=%s"], { cwd }),
    ]);
    assert.equal(localSnapshot.workspace?.mode, "local");
    assert.equal(localSnapshot.workspace?.changedCount, 2);
    assert.deepEqual(
      localFiles.files
        .filter(file => file.status)
        .map(file => file.path)
        .sort(),
      ["README.md", "local.txt"],
    );
    assert.match(readmeDiff.text ?? "", /^\+project-folder$/m);
    assert.equal(branch.stdout.trim(), originalBranch);
    assert.equal(finalReadme.replaceAll("\r\n", "\n"), "base\nisolated\nproject-folder\n");
    assert.equal(localized.sessionId, slot.id);
    assert.equal(latestCommit.stdout.trim(), "Initial");
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter(session => session.cwd.startsWith(root));
    await Promise.all(sessions.map(session => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});
