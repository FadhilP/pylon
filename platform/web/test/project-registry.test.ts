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
    assert.equal(stored.version, 4);
    assert.equal(stored.projects.length, 2);

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

    await registry.activateSession("session-one");
    await registry.activateSession("session-two");
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

test("Windows picker uses the modern Explorer dialog with a topmost owner", () => {
  const picker = projectPickerCommand("win32");
  assert.equal(picker.command, "powershell.exe");
  assert.match(picker.args.join(" "), /TopMost = \$true/);
  assert.match(picker.args.join(" "), /OpenFileDialog/);
  assert.match(picker.args.join(" "), /AutoUpgradeEnabled = \$true/);
  assert.match(picker.args.join(" "), /ShowDialog\(\$owner\)/);
});
