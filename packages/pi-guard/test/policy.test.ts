import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commandRisk,
  DEFAULT_GUARD_RULES,
  GUARD_RISK_CATEGORIES,
  mergeGuardRules,
  pathRisk,
  validateGuardRules,
} from "../src/policy.ts";

const category = GUARD_RISK_CATEGORIES;

test("command categories have stable IDs and confirmation defaults", () => {
  const cases: Array<[string, (typeof category)[keyof typeof category]]> = [
    ["sudo npm test", category.COMMAND_PRIVILEGE_ESCALATION],
    ["rm -rf build", category.COMMAND_RECURSIVE_DELETION],
    ["rmdir /s build", category.COMMAND_RECURSIVE_DELETION],
    ["del /s build\\*.tmp", category.COMMAND_RECURSIVE_DELETION],
    ["git reset --hard HEAD~1", category.COMMAND_DESTRUCTIVE_GIT_RESET],
    ["git clean -fd", category.COMMAND_DESTRUCTIVE_GIT_CLEAN],
    [
      "git push origin main --force-with-lease",
      category.COMMAND_FORCED_GIT_PUSH,
    ],
    ["diskpart", category.COMMAND_DISK_MODIFICATION],
    ["dd if=image of=/dev/sda", category.COMMAND_RAW_DEVICE_WRITE],
    ["chmod -R 777 build", category.COMMAND_RECURSIVE_PERMISSION_CHANGE],
  ];
  for (const [command, expected] of cases) {
    const risk = commandRisk(command);
    assert.equal(risk?.category, expected);
    assert.equal(DEFAULT_GUARD_RULES[risk!.category], "confirm");
  }
  assert.equal(commandRisk("rm file.txt"), undefined);
  assert.equal(commandRisk("git push origin main"), undefined);
});

test("sparse rules validate and merge over safe defaults", () => {
  assert.deepEqual(
    validateGuardRules({ [category.COMMAND_RECURSIVE_DELETION]: "allow" }),
    {
      [category.COMMAND_RECURSIVE_DELETION]: "allow",
    },
  );
  assert.equal(
    mergeGuardRules({ [category.COMMAND_RECURSIVE_DELETION]: "allow" })[
      category.COMMAND_RECURSIVE_DELETION
    ],
    "allow",
  );
  assert.equal(DEFAULT_GUARD_RULES[category.PATH_GIT_INTERNALS], "block");
  assert.equal(
    validateGuardRules({ [category.COMMAND_RECURSIVE_DELETION]: "ask" }),
    undefined,
  );
  assert.equal(validateGuardRules({ unknown: "allow" }), undefined);
  assert.equal(validateGuardRules([]), undefined);
});

test("path categories preserve existing safety defaults", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-guard-"));
  const root = join(parent, "repo");
  await mkdir(root);
  const cases: Array<
    [string, (typeof category)[keyof typeof category], "block" | "confirm"]
  > = [
    ["../outside.txt", category.PATH_WORKSPACE_ESCAPE, "block"],
    [join(parent, "outside.txt"), category.PATH_OUTSIDE_WORKSPACE, "confirm"],
    [".git/config", category.PATH_GIT_INTERNALS, "block"],
    ["node_modules/pkg/index.js", category.PATH_NODE_MODULES, "block"],
    [".env.local", category.PATH_ENVIRONMENT_FILE, "confirm"],
  ];
  await symlink(
    parent,
    join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  cases.push(["escape/outside.txt", category.PATH_WORKSPACE_ESCAPE, "block"]);
  for (const [input, expected, action] of cases) {
    const risk = await pathRisk(root, input);
    assert.equal(risk?.category, expected);
    assert.equal(DEFAULT_GUARD_RULES[risk!.category], action);
    assert.ok(
      risk?.target,
      "path risks retain the canonical target for an override to confirm",
    );
  }
  assert.equal(await pathRisk(root, "src/index.ts"), undefined);
});
