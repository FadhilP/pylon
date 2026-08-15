import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GUARD_RULES } from "../src/shared/guard-policy.ts";
import { GENERAL_PROJECT_ID } from "../src/shared/general-session.ts";
import { ProjectRegistry, projectIdForCwd, projectPickerCommand } from "../src/server/pi/project-registry.ts";

test("General is a built-in local scope rooted outside the project list", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-general-"));
  const generalCwd = join(root, "home");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(generalCwd);
  try {
    const registry = new ProjectRegistry(config, generalCwd);
    await registry.load([]);

    assert.deepEqual(registry.list(), []);
    assert.equal(registry.get(GENERAL_PROJECT_ID)?.cwd, generalCwd);
    const policy = registry.runtimePolicy(GENERAL_PROJECT_ID, "general-session");
    assert.equal(policy.effective.workspace, "local");
    assert.equal(policy.effective.toolOverrides?.code_search, "disabled");
    assert.equal(policy.effective.toolOverrides?.bash, "disabled");
    assert.equal(policy.effective.toolOverrides?.edit, "disabled");

    await registry.setSessionWorkspace({ sessionId: "general-session", projectId: GENERAL_PROJECT_ID, mode: "local" });
    assert.equal(registry.projectForSession("general-session", root)?.id, GENERAL_PROJECT_ID);
    assert.equal(registry.effectiveCwd("general-session", root), generalCwd);

    const reloaded = new ProjectRegistry(config, generalCwd);
    await reloaded.load([]);
    assert.equal(reloaded.workspaceForSession("general-session")?.projectId, GENERAL_PROJECT_ID);
    assert.equal(reloaded.effectiveCwd("general-session", root), generalCwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


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
    await registry.renameProject(projectIdForCwd(second), "Renamed project");
    await assert.rejects(registry.renameProject(projectIdForCwd(second), " "), /invalid project name/);
    const stored = JSON.parse(await readFile(config, "utf8"));
    assert.equal(stored.version, 13);
    assert.equal(stored.projects.length, 2);
    assert.equal(stored.projects[1].label, "Renamed project");
    assert.equal(registry.runtimePolicy(projectIdForCwd(first), "new-session").effective.workspace, "local");

    let seeded = false;
    const reloaded = new ProjectRegistry(config);
    await reloaded.load(async () => {
      seeded = true;
      return [first];
    });
    assert.equal(seeded, false);
    assert.equal(reloaded.get(projectIdForCwd(second))?.label, "Renamed project");

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
    await registry.pinSession("session-two");
    await registry.pinSession("session-two");
    assert.deepEqual(registry.listPinnedSessionIds(), ["session-two"]);
    await registry.rekeySession("session-two", "session-rekeyed");
    assert.equal(registry.isSessionPinned("session-rekeyed"), true);
    await registry.archiveSession("session-rekeyed");
    assert.equal(registry.isSessionPinned("session-rekeyed"), false);
    await assert.rejects(registry.reorderActiveSession("missing"), /unavailable/);

    const reloaded = new ProjectRegistry(config);
    await reloaded.load([]);
    assert.deepEqual(reloaded.list().map((project) => project.id), [two, one, three]);
    assert.deepEqual(reloaded.listActiveSessionOrder(), ["session-rekeyed"]);
    assert.deepEqual(reloaded.listPinnedSessionIds(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fork rekey copies shareable metadata without duplicating exclusive workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-project-fork-rekey-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  try {
    const registry = new ProjectRegistry(config);
    await registry.load([project]);
    const projectId = projectIdForCwd(project);
    await registry.setSessionWorkspace({ sessionId: "local-source", projectId, mode: "local" });
    await registry.updateRuntimePolicy({
      scope: "session",
      projectId,
      sessionId: "local-source",
      verify: { mode: "auto" },
      timeline: "enabled",
      guard: "enabled",
      workspace: "local",
      guardTimeoutSeconds: 120,
      clarifyTimeoutSeconds: "inherit",
      expectedRevision: 0,
    });
    await registry.updateToolPolicy({
      scope: "session",
      projectId,
      sessionId: "local-source",
      tool: "spawn_agent",
      mode: "disabled",
      expectedRevision: 1,
    });
    await registry.activateSession("local-source");
    await registry.pinSession("local-source");

    await registry.rekeySession("local-source", "local-fork", "fork");

    assert.equal(registry.workspaceForSession("local-source")?.mode, "local");
    assert.equal(registry.workspaceForSession("local-fork")?.mode, "local");
    assert.equal(registry.runtimePolicy(projectId, "local-source").session.guardTimeoutSeconds, 120);
    assert.equal(registry.runtimePolicy(projectId, "local-fork").session.guardTimeoutSeconds, 120);
    assert.deepEqual(registry.listActiveSessionOrder(), ["local-fork"]);
    assert.equal(registry.isSessionPinned("local-source"), false);
    assert.equal(registry.isSessionPinned("local-fork"), true);
    await registry.updateToolPolicy({
      scope: "session",
      projectId,
      sessionId: "local-source",
      tool: "spawn_agent",
      mode: "active",
      expectedRevision: 2,
    });
    assert.equal(registry.runtimePolicy(projectId, "local-source").session.toolOverrides?.spawn_agent, "active");
    assert.equal(registry.runtimePolicy(projectId, "local-fork").session.toolOverrides?.spawn_agent, "disabled");

    const worktree = {
      sessionId: "worktree-source",
      projectId,
      mode: "worktree" as const,
      worktreePath: join(root, "worktree"),
      commonDir: join(project, ".git"),
      branch: "refs/heads/pylon-session-test",
      baseline: "a".repeat(40),
      baselineTree: "b".repeat(40),
    };
    await registry.setSessionWorkspace(worktree);
    await registry.rekeySession("worktree-source", "worktree-fork", "fork");
    assert.equal(registry.workspaceForSession("worktree-source"), undefined);
    assert.deepEqual(registry.workspaceForSession("worktree-fork"), { ...worktree, sessionId: "worktree-fork" });

    const reloaded = new ProjectRegistry(config);
    await reloaded.load();
    assert.equal(reloaded.workspaceForSession("local-source")?.mode, "local");
    assert.equal(reloaded.workspaceForSession("local-fork")?.mode, "local");
    assert.equal(reloaded.workspaceForSession("worktree-source"), undefined);
    assert.equal(reloaded.workspaceForSession("worktree-fork")?.mode, "worktree");
    assert.equal(reloaded.runtimePolicy(projectId, "local-source").session.toolOverrides?.spawn_agent, "active");
    assert.equal(reloaded.runtimePolicy(projectId, "local-fork").session.toolOverrides?.spawn_agent, "disabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version 9 active sessions migrate without becoming pinned", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-project-pin-migration-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  try {
    const registry = new ProjectRegistry(config);
    await registry.load([project]);
    await registry.activateSession("legacy-active");
    const stored = JSON.parse(await readFile(config, "utf8"));
    stored.version = 9;
    delete stored.pinnedSessionIds;
    delete stored.globalPolicy.guardEnabled;
    await writeFile(config, JSON.stringify(stored));

    const migrated = new ProjectRegistry(config);
    await migrated.load();
    assert.deepEqual(migrated.listActiveSessionOrder(), ["legacy-active"]);
    assert.deepEqual(migrated.listPinnedSessionIds(), []);
    assert.equal(migrated.runtimePolicy(projectIdForCwd(project), "legacy-active").effective.guardEnabled, true);
    assert.equal(JSON.parse(await readFile(config, "utf8")).version, 13);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version 10 registries migrate to version 13", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-project-v10-migration-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  try {
    const registry = new ProjectRegistry(config);
    await registry.load([project]);
    const stored = JSON.parse(await readFile(config, "utf8"));
    stored.version = 10;
    delete stored.globalPolicy.guardEnabled;
    await writeFile(config, JSON.stringify(stored));

    const migrated = new ProjectRegistry(config);
    await migrated.load();
    assert.equal(migrated.runtimePolicy(projectIdForCwd(project), "session").effective.guardEnabled, true);
    assert.equal(JSON.parse(await readFile(config, "utf8")).version, 13);
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
    assert.equal(registry.runtimePolicy(workspace.projectId, "session-one").project.workspace, undefined);
    assert.equal(registry.runtimePolicy(workspace.projectId, "session-one").session.workspace, "local");
    assert.deepEqual(registry.workspaceForSession("session-one"), workspace);
    const stored = JSON.parse(await readFile(config, "utf8"));
    assert.equal(stored.version, 13);
    assert.deepEqual(stored.pinnedSessionIds, []);
    assert.equal(stored.projects[0].workspacePolicy, undefined);
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
      timeline: "disabled", guard: "disabled",
      guardRules: { "command.recursive-deletion": "allow" },
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
      timeline: "enabled", guard: "enabled",
      guardRules: { "command.recursive-deletion": "block" },
      workspace: "local",
      guardTimeoutSeconds: 120,
      clarifyTimeoutSeconds: "inherit",
      expectedRevision: 1,
    });
    assert.deepEqual(registry.runtimePolicy(projectId, "session-one").effective, {
      verify: { mode: "auto" },
      toolOverrides: {},
      timelineEnabled: true,
      guardEnabled: true,
      guardRules: { ...DEFAULT_GUARD_RULES, "command.recursive-deletion": "block" },
      workspace: "local",
      guardTimeoutSeconds: 120,
      clarifyTimeoutSeconds: 90,
    });
    assert.deepEqual(registry.runtimePolicy(projectId, "session-two").effective, {
      verify: { mode: "selected", checks: ["npm:test"] },
      toolOverrides: {},
      timelineEnabled: false,
      guardEnabled: false,
      guardRules: { ...DEFAULT_GUARD_RULES, "command.recursive-deletion": "allow" },
      workspace: "worktree",
      guardTimeoutSeconds: null,
      clarifyTimeoutSeconds: 90,
    });

    const reloaded = new ProjectRegistry(config);
    await reloaded.load();
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").revision, 2);
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").session.timelineEnabled, true);
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").session.guardEnabled, true);
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").project.guardRules?.["command.recursive-deletion"], "allow");
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").session.guardRules?.["command.recursive-deletion"], "block");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool policy overrides inherit across global project and session scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-tool-policy-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  try {
    const registry = new ProjectRegistry(config);
    await registry.load([project]);
    const projectId = projectIdForCwd(project);
    await registry.updateToolPolicy({ scope: "global", projectId, sessionId: "session-one", tool: "spawn_agent", mode: "deferred", expectedRevision: 0 });
    await registry.updateToolPolicy({ scope: "project", projectId, sessionId: "session-one", tool: "spawn_agent", mode: "active", expectedRevision: 1 });
    await registry.updateToolPolicy({ scope: "session", projectId, sessionId: "session-one", tool: "spawn_agent", mode: "disabled", expectedRevision: 2 });
    assert.equal(registry.runtimePolicy(projectId, "session-one").effective.toolOverrides?.spawn_agent, "disabled");
    assert.equal(registry.runtimePolicy(projectId, "session-two").effective.toolOverrides?.spawn_agent, "active");

    const reloaded = new ProjectRegistry(config);
    await reloaded.load();
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").effective.toolOverrides?.spawn_agent, "disabled");
    await reloaded.updateToolPolicy({ scope: "session", projectId, sessionId: "session-one", tool: "spawn_agent", mode: "inherit", expectedRevision: 3 });
    assert.equal(reloaded.runtimePolicy(projectId, "session-one").effective.toolOverrides?.spawn_agent, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global runtime policy is inherited independently by projects and sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-global-policy-"));
  const project = join(root, "project");
  const config = join(root, "agent", "pylon-web", "projects.json");
  await mkdir(project);
  try {
    const registry = new ProjectRegistry(config);
    await registry.load([project]);
    const projectId = projectIdForCwd(project);
    await registry.updateRuntimePolicy({
      scope: "global",
      projectId,
      sessionId: "session-one",
      verify: { mode: "inherit" },
      timeline: "disabled", guard: "disabled",
      workspace: "worktree",
      guardTimeoutSeconds: null,
      clarifyTimeoutSeconds: 300,
      expectedRevision: 0,
    });
    assert.deepEqual(registry.runtimePolicy(projectId, "session-one").effective, {
      verify: { mode: "auto" },
      toolOverrides: {},
      timelineEnabled: false,
      guardEnabled: false,
      guardRules: DEFAULT_GUARD_RULES,
      workspace: "worktree",
      guardTimeoutSeconds: null,
      clarifyTimeoutSeconds: 300,
    });
    await registry.updateRuntimePolicy({
      scope: "project",
      projectId,
      sessionId: "session-one",
      verify: { mode: "auto" },
      timeline: "enabled", guard: "enabled",
      workspace: "inherit",
      guardTimeoutSeconds: "inherit",
      clarifyTimeoutSeconds: 600,
      expectedRevision: 1,
    });
    const policy = registry.runtimePolicy(projectId, "session-one");
    assert.equal(policy.project.workspace, undefined);
    assert.equal(policy.effective.workspace, "worktree");
    assert.equal(policy.effective.timelineEnabled, true);
    assert.equal(policy.effective.guardEnabled, true);
    assert.equal(policy.effective.clarifyTimeoutSeconds, 600);

    await registry.updateRuntimePolicy({
      scope: "project",
      projectId,
      sessionId: "session-one",
      verify: { mode: "auto" },
      timeline: "enabled", guard: "inherit",
      workspace: "inherit",
      guardTimeoutSeconds: "inherit",
      clarifyTimeoutSeconds: 600,
      expectedRevision: 2,
    });
    assert.equal(registry.runtimePolicy(projectId, "session-one").project.guardEnabled, undefined);
    assert.equal(registry.runtimePolicy(projectId, "session-one").effective.guardEnabled, false);
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
