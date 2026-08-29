import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerWorkspace } from "../src/workspace.ts";

test("workspace registration prunes only old missing inert entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-workspaces-"));
  const current = await mkdtemp(join(tmpdir(), "continuity-current-"));
  const old = "2020-01-01T00:00:00.000Z";
  await writeFile(
    join(root, "workspaces.json"),
    JSON.stringify([
      { id: "inert", canonicalPath: join(root, "missing-inert"), createdAt: old, lastSeenAt: old },
      {
        id: "owned",
        canonicalPath: join(root, "missing-owned"),
        projectOwner: "owner",
        createdAt: old,
        lastSeenAt: old,
      },
    ]),
  );

  await registerWorkspace(root, current);
  const workspaces = JSON.parse(await readFile(join(root, "workspaces.json"), "utf8"));
  assert.equal(
    workspaces.some((item: any) => item.id === "inert"),
    false,
  );
  assert.equal(
    workspaces.some((item: any) => item.id === "owned"),
    true,
  );
});
