import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, projectIdForCwd, projectPickerCommand } from "../src/server/pi/project-registry.ts";

test("project registry seeds, deduplicates, persists, and removes canonical directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-projects-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await Promise.all([mkdir(first), mkdir(second)]);
  try {
    const registry = new ProjectRegistry(config);
    await registry.load([first, first]);
    assert.deepEqual(registry.list().map((project) => project.id), [projectIdForCwd(first)]);

    await registry.add(first);
    await registry.add(second);
    assert.equal(registry.list().length, 2);
    const stored = JSON.parse(await readFile(config, "utf8"));
    assert.equal(stored.version, 8);
    assert.equal(stored.projects.length, 2);
    assert.equal(registry.runtimePolicy(projectIdForCwd(first), "new-session").effective.workspace, "local");

    let seeded = false;
    const reloaded = new ProjectRegistry(config);
    await reloaded.load(async () => {
      seeded = true;
      return [first];
    });
    assert.equal(seeded, false);

    const project = registry.get(projectIdForCwd(second))!;
    await registry.updateWorktreeSettings(project.id, "npm install");
    await registry.setSessionWorkspace({
      sessionId: "session-one",
      projectId: project.id,
      mode: "worktree",
      worktreePath: join(root, "worktree"),
      commonDir: join(root, ".git"),
      branch: "refs/heads/pylon/sessions/session-one",
      baseline: "a".repeat(40),
      baselineTree: "b".repeat(40),
    });
    assert.equal(registry.projectForSession("session-one", join(root, "elsewhere"))?.id, project.id);
    assert.equal(registry.workspaceForSession("session-one")?.mode, "worktree");
    assert.equal(registry.get(project.id)?.setupCommand, "npm install");
    const checkoutState = {
      root: second,
      commonDir: join(second, ".git"),
      head: "a".repeat(40),
      headRef: "refs/heads/main",
      indexTree: "b".repeat(40),
      worktreeTree: "c".repeat(40),
    };
    await registry.writeHandoffJournal({
      version: 1,
      sessionId: "session-one",
      projectId: project.id,
      workspace: registry.workspaceForSession("session-one")!,
      projectState: checkoutState,
      sessionState: checkoutState,
    });
    assert.equal((await registry.readHandoffJournal())?.sessionId, "session-one");
    await registry.clearHandoffJournal();
    assert.equal(await registry.readHandoffJournal(), undefined);
    await registry.writeProvisionJournal({
      version: 1,
      projectId: project.id,
      worktreePath: join(root, "provisional"),
      commonDir: join(second, ".git"),
      branch: "refs/heads/pylon/sessions/provisional",
    });
    assert.equal((await registry.readProvisionJournal())?.branch, "refs/heads/pylon/sessions/provisional");
    await registry.clearProvisionJournal();
    assert.equal(await registry.readProvisionJournal(), undefined);

    await registry.remove(projectIdForCwd(first));
    assert.deepEqual(registry.list().map((project) => project.id), [projectIdForCwd(second)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project and active-session ordering persists and rejects stale members", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-project-order-"));
  const config = join(root, "agent", "pylon-web", "projects.json");
  const directories = [join(root, "one"), join(root, "two"), join(root, "three")];
  await Promise.all(directories.map((directory) => mkdir(directory)));
  try {
    const registry = new ProjectRegistry(config);
    await registry.load(directories);
    const [one, two, three] = registry.list().map((project) => project.id);
    await registry.reorderProject(three!, one);
    assert.deepEqual(registry.list().map((project) => project.id), [three, one, two]);
    await registry.archiveProject(one!);
    await registry.reorderProject(two!, three);
    await registry.restoreProject(one!);
    assert.deepEqual(registry.list().map((project) => project.id), [two, one, three]);

    await Promise.all([
      registry.activateSession("session-one"),
      registry.activateSession("session-two"),
    ]);
    assert.deepEqual(registry.listActiveSessionOrder(), ["session-two", "session-one"]);
    await registry.reorderActiveSession("session-two");
    await registry.deactivateSession("session-one");
    assert.deepEqual(registry.listActiveSessionOrder(), ["session-two"]);
    await assert.rejects(registry.reorderActiveSession("missing"), /unavailable/);

    const reloaded = new ProjectRegistry(config);
    await reloaded.load([]);
    assert.deepEqual(reloaded.list().map((project) => project.id), [two, one, three]);
    assert.deepEqual(reloaded.listActiveSessionOrder(), ["session-two"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project registry migrates and persists reversible project and session archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-project-archive-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  await mkdir(join(root, "agent", "pylon-web"), { recursive: true });
  await writeFile(config, JSON.stringify({ version: 1, directories: [project] }));
  try {
    const id = projectIdForCwd(project);
    const registry = new ProjectRegistry(config);
    await registry.load();
    assert.equal(registry.runtimePolicy(id, "session-one").effective.guardTimeoutSeconds, 60);
    assert.equal(registry.runtimePolicy(id, "session-one").effective.clarifyTimeoutSeconds, 60);
    await registry.archiveSession("session-one");
    await registry.archiveProject(id);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.listArchived()[0]?.id, id);
    await assert.rejects(registry.add(project), /restore it from Archived/);

    const reloaded = new ProjectRegistry(config);
    await reloaded.load();
    assert.equal(reloaded.isSessionArchived("session-one"), true);
    await reloaded.restoreProject(id);
    assert.equal(reloaded.list()[0]?.id, id);
    assert.equal(reloaded.isSessionArchived("session-one"), true);
    await reloaded.remove(id, ["session-one"]);
    assert.equal(reloaded.isSessionArchived("session-one"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version 7 Automatic policies migrate to Local without moving session workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-project-policy-migration-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  await mkdir(join(root, "agent", "pylon-web"), { recursive: true });
  const workspace = {
    sessionId: "session-one",
    projectId: projectIdForCwd(project),
    mode: "worktree",
    worktreePath: join(root, "worktree"),
    commonDir: join(project, ".git"),
    branch: "refs/heads/pylon-session-one",
    baseline: "a".repeat(40),
    baselineTree: "b".repeat(40),
  };
  await writeFile(config, JSON.stringify({
    version: 7,
    projects: [{ directory: project, workspacePolicy: "automatic" }],
    archivedSessions: [],
    sessionWorkspaces: [workspace],
    activeSessionOrder: [],
    sessionPolicies: [{
      sessionId: "session-one",
      projectId: workspace.projectId,
      workspace: "automatic",
    }],
    policyRevision: 2,
  }));
  try {
    const registry = new ProjectRegistry(config);
    await registry.load();
    assert.equal(registry.runtimePolicy(workspace.projectId, "session-one").project.workspace, "local");
    assert.equal(registry.runtimePolicy(workspace.projectId, "session-one").session.workspace, "local");
    assert.deepEqual(registry.workspaceForSession("session-one"), workspace);
    const stored = JSON.parse(await readFile(config, "utf8"));
    assert.equal(stored.version, 8);
    assert.equal(stored.projects[0].workspacePolicy, "local");
    assert.equal(stored.sessionPolicies[0].workspace, "local");
    assert.deepEqual(stored.sessionWorkspaces[0], workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime policy persists project defaults and session overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-project-policy-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  try {
    const registry = new ProjectRegistry(config);
    await registry.load([project]);
    const projectId = projectIdForCwd(project);
    await registry.updateRuntimePolicy({
      scope: "project",
      projectId,
      sessionId: "session-one",
      verify: { mode: "selected", checks: ["npm:test"] },
      timeline: "disabled",
      workspace: "worktree",
      guardTimeoutSeconds: null,
      clarifyTimeoutSeconds: 90,
      expectedRevision: 0,
    });
    await registry.updateRuntimePolicy({
      scope: "session",
      projectId,
      sessionId: "session-one",
      verify: { mode: "auto" },
      timeline: "enabled",
      workspace: "local",
      guardTimeoutSeconds: 120,
      clarifyTimeoutSeconds: "inherit",
      expectedRevision: 1,
    });
    assert.deepEqual(registry.runtimePolicy(projectId, "session-one").effective, {
      verify: { mode: "auto" },
      timelineEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 120,
      clarifyTimeoutSeconds: 90,
    });
    assert.deepEqual(registry.runtimePolicy(projectId, "session-two").effective, {
      verify: { mode: "selected", checks: ["npm:test"] },
      timelineEnabled: false,
      workspace: "worktree",
      guardTimeoutSeconds: null,
      clarifyTimeoutSeconds: 90,
    });

    const reloaded = new ProjectRegistry(config);
    await reloaded.load();
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").revision, 2);
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").session.timelineEnabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows picker uses the modern Explorer dialog with a topmost owner", () => {
  const picker = projectPickerCommand("win32");
  assert.equal(picker.command, "powershell.exe");
  assert.match(picker.args.join(" "), /TopMost = \$true/);
  assert.match(picker.args.join(" "), /OpenFileDialog/);
  assert.match(picker.args.join(" "), /AutoUpgradeEnabled = \$true/);
  assert.match(picker.args.join(" "), /ShowDialog\(\$owner\)/);
});
