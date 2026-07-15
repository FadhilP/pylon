import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandRisk, pathRisk } from "../src/policy.ts";

test("flags narrow destructive command families", () => {
  assert.equal(commandRisk("rm -rf build"), "recursive deletion");
  assert.equal(commandRisk("git reset --hard HEAD~1"), "destructive Git reset");
  assert.equal(commandRisk("git push origin main --force-with-lease"), "forced Git push");
  assert.equal(commandRisk("git push -f origin main"), "forced Git push");
  assert.equal(commandRisk("sudo npm test"), "privilege escalation");
  assert.equal(commandRisk("rm file.txt"), undefined);
  assert.equal(commandRisk("git push origin main"), undefined);
  assert.equal(commandRisk("npm test"), undefined);
});

test("blocks escaped and generated writes, confirms environment files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-guard-"));
  const root = join(parent, "repo");
  await mkdir(root);
  assert.deepEqual(await pathRisk(root, "../outside.txt"), {
    action: "block", reason: "write target escapes workspace",
  });
  const outside = join(parent, "outside.txt");
  assert.deepEqual(await pathRisk(root, outside), {
    action: "confirm", reason: "write target is outside workspace", target: outside,
  });
  await symlink(parent, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await pathRisk(root, "escape/outside.txt"), {
    action: "block", reason: "write target escapes workspace",
  });
  assert.deepEqual(await pathRisk(root, ".git/config"), {
    action: "block", reason: ".git internals are protected",
  });
  assert.deepEqual(await pathRisk(root, "node_modules/pkg/index.js"), {
    action: "block", reason: "node_modules is generated and protected",
  });
  assert.deepEqual(await pathRisk(root, ".env.local"), {
    action: "confirm", reason: "environment file may contain secrets",
  });
  assert.equal(await pathRisk(root, "src/index.ts"), undefined);
});
