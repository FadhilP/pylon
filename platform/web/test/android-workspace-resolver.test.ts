import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndroidWorkspace } from "../src/server/android/workspace-resolver.ts";

test("Android workspace resolution captures one generation and canonical registered identity", async () => {
  const registeredRoot = await mkdtemp(join(tmpdir(), "pylon-android-registered-"));
  const worktree = join(registeredRoot, "worktree");
  await mkdir(worktree);
  try {
    const resolved = await resolveAndroidWorkspace(
      expectedGeneration => ({
        projectId: "project-1",
        sessionId: "session-1",
        sessionGeneration: expectedGeneration,
        root: worktree,
        registeredRoot,
        workspaceKind: "session-worktree",
        workspaceLabel: "Project",
      }),
      7,
    );
    assert.equal(resolved.sessionGeneration, 7);
    assert.equal(resolved.canonicalRoot, worktree);
    assert.equal(resolved.canonicalRegisteredRoot, registeredRoot);

    await assert.rejects(
      resolveAndroidWorkspace(
        () => ({
          projectId: "project-1",
          sessionId: "session-1",
          sessionGeneration: 8,
          root: worktree,
          registeredRoot,
          workspaceKind: "session-worktree",
          workspaceLabel: "Project",
        }),
        7,
      ),
      /stale or invalid/,
    );
  } finally {
    await rm(registeredRoot, { recursive: true, force: true });
  }
});
