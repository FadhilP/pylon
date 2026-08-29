import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capturePapercut } from "../src/papercuts.ts";
import {
  loadProjectState,
  MAX_STATE_BYTES,
  normalizeProjectIdentity,
  projectRoot,
  statePath,
  updateProjectState,
} from "../src/storage.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "papercut-storage-"));
  const repo = join(root, "repo");
  const nested = join(repo, "src", "feature");
  const agent = join(root, "agent");
  await mkdir(nested, { recursive: true });
  await writeFile(join(repo, ".git"), "gitdir: elsewhere\n");
  return { root, repo, nested, agent };
}

test("project identity handles Git marker files, symlink aliases, and Windows casing", async () => {
  const item = await fixture();
  try {
    assert.equal(await projectRoot(item.nested), item.repo);
    assert.equal(
      normalizeProjectIdentity("C:\\Work\\Repo", "win32"),
      "c:/work/repo",
    );
    const alias = join(item.root, "alias");
    await symlink(
      item.repo,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasRoot = await projectRoot(join(alias, "src"));
    assert.equal(aliasRoot, item.repo);
    assert.equal(
      statePath(item.agent, aliasRoot),
      statePath(item.agent, item.repo),
    );

    const plain = join(item.root, "plain", "nested");
    await mkdir(plain, { recursive: true });
    assert.equal(await projectRoot(plain), plain);
    assert.notEqual(
      statePath(item.agent, plain),
      statePath(item.agent, item.repo),
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("concurrent captures are serialized without lost updates", async () => {
  const item = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        updateProjectState(item.agent, item.nested, (state) => {
          const captured = capturePapercut(
            state,
            `Friction ${index}`,
            {},
            undefined,
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          );
          return { state: captured.state, result: captured.record.id };
        }),
      ),
    );
    const loaded = await loadProjectState(item.agent, item.nested);
    assert.equal(loaded.root, item.repo);
    assert.equal(loaded.state.records.length, 20);
    assert.equal(
      new Set(loaded.state.records.map((record) => record.id)).size,
      20,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(loaded.path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("malformed state is quarantined and stale locks are recovered", async () => {
  const item = await fixture();
  try {
    const path = statePath(item.agent, item.repo);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{broken", { mode: 0o600 });
    const reset = await loadProjectState(item.agent, item.nested);
    assert.equal(reset.state.records.length, 0);
    assert.ok(
      (await readdir(dirname(path))).some((name) =>
        name.startsWith(`${path.split(/[\\/]/).pop()}.corrupt-`),
      ),
    );

    await writeFile(path, "{broken", { mode: 0o600 });
    await Promise.all([
      loadProjectState(item.agent, item.nested),
      updateProjectState(item.agent, item.nested, (state) => {
        const captured = capturePapercut(state, "Race-safe capture", {});
        return { state: captured.state, result: undefined };
      }),
    ]);
    assert.equal(
      (await loadProjectState(item.agent, item.nested)).state.records.length,
      1,
    );

    if (process.platform !== "win32") {
      await chmod(dirname(path), 0o777);
      await loadProjectState(item.agent, item.nested);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }

    const lock = `${path}.lock`;
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        token: "dead",
        pid: 999_999_999,
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await updateProjectState(item.agent, item.nested, (state) => ({
      state,
      result: undefined,
    }));
    await assert.rejects(readFile(join(lock, "owner.json")), /ENOENT/);

    await writeFile(path, "x".repeat(MAX_STATE_BYTES + 1));
    await assert.rejects(
      loadProjectState(item.agent, item.nested),
      /exceeds 2 MiB limit/,
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
