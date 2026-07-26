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
    assert.equal(stored.version, 2);
    assert.equal(stored.projects.length, 2);

    await registry.remove(projectIdForCwd(first));
    assert.deepEqual(registry.list().map((project) => project.id), [projectIdForCwd(second)]);
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
