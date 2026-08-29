import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointChanges, checkpointFileDiff } from "../src/changes.ts";
import { git } from "../src/git.ts";
import { capture } from "../src/snapshot.ts";

test("checkpoint changes compare first against HEAD and later against the prior checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-timeline-changes-"));
  try {
    await git(root, ["init"]);
    await writeFile(join(root, "tracked.txt"), "one\n");
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ]);

    await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(root, "added.txt"), "added\n");
    const first = await capture(root, "session");
    const firstChanges = await checkpointChanges(first);
    assert.deepEqual(
      firstChanges.files.map((item) => item.path),
      ["added.txt", "tracked.txt"],
    );
    assert.equal(firstChanges.additions, 2);

    await unlink(join(root, "added.txt"));
    await writeFile(join(root, "tracked.txt"), "one\nthree\n");
    const second = await capture(root, "session");
    const laterChanges = await checkpointChanges(second, first);
    assert.deepEqual(
      laterChanges.files.map((item) => item.status),
      ["deleted", "modified"],
    );
    const diff = await checkpointFileDiff(second, first, "tracked.txt");
    assert.equal(diff.state, "text");
    assert.match(diff.text ?? "", /-two/);
    assert.match(diff.text ?? "", /\+three/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
