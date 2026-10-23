import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
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

test("Android workspace resolution rejects a linked selected or registered root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-android-root-link-"));
  const target = join(root, "target");
  const linked = join(root, "linked");
  try {
    await mkdir(target);
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    for (const selection of [
      { root: linked, registeredRoot: target },
      { root: target, registeredRoot: linked },
    ]) {
      await assert.rejects(
        resolveAndroidWorkspace(
          () => ({
            projectId: "project-1",
            sessionId: "session-1",
            sessionGeneration: 7,
            workspaceKind: "project-folder",
            workspaceLabel: "Project",
            ...selection,
          }),
          7,
        ),
        /unavailable/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
