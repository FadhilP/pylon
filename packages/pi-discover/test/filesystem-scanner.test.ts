import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFilesystemFile, scanFilesystem } from "../src/filesystem-scanner.ts";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "discover-filesystem-"));
}

async function put(root: string, path: string, content = "export const value = 1;\n"): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

test("filesystem scanner applies scoped ignores, negation, and default opt-ins", async () => {
  const root = await workspace();
  try {
    await put(
      root,
      ".gitignore",
      ["!.hidden.ts", "!node_modules/", "!dist/", "nested/*.ts", "blocked/", "reopen/*", "!.git/"].join("\n") + "\n",
    );
    await put(root, ".hidden.ts");
    await put(root, "node_modules/default.ts");
    await put(root, "dist/default.ts");
    await put(root, "nested/.gitignore", "!keep.ts\n");
    await put(root, "nested/keep.ts");
    await put(root, "nested/drop.ts");
    await put(root, "blocked/nope.ts");
    await put(root, "blocked/.gitignore", "!nope.ts\n");
    await put(root, "reopen/.gitignore", "!child/\n");
    await put(root, "reopen/child/kept.ts");
    await put(root, "reopen/other/skipped.ts");
    await put(root, ".git/private.ts");

    const scan = await scanFilesystem(root, undefined, 5_000);
    assert.deepEqual([...scan.files.keys()].sort(), [
      ".hidden.ts",
      "dist/default.ts",
      "nested/keep.ts",
      "node_modules/default.ts",
      "reopen/child/kept.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem scanner excludes links and unsupported entries", async () => {
  const root = await workspace();
  const external = await workspace();
  try {
    await put(root, "included.ts");
    await put(root, "notes.txt", "not source\n");
    await put(root, "large.ts", "x".repeat(513 * 1024));
    await put(external, "outside.ts");
    await symlink(external, join(root, "outside"), process.platform === "win32" ? "junction" : "dir");

    const scan = await scanFilesystem(root, undefined, 5_000);
    assert.deepEqual([...scan.files.keys()], ["included.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("filesystem tokens include metadata and inventory deletion", async () => {
  const root = await workspace();
  try {
    await put(root, "file.ts", "export const original = 1;\n");
    const first = await scanFilesystem(root, undefined, 5_000);
    await put(root, ".gitignore", "# token-only rule change\n");
    const rulesChanged = await scanFilesystem(root, undefined, 5_000);
    assert.notEqual(rulesChanged.token, first.token);
    await writeFile(join(root, "file.ts"), "export const changed = 2;\n");
    const second = await scanFilesystem(root, undefined, 5_000);
    assert.notEqual(second.token, rulesChanged.token);
    await rm(join(root, "file.ts"));
    const third = await scanFilesystem(root, undefined, 5_000);
    assert.equal(third.files.has("file.ts"), false);
    assert.notEqual(third.token, second.token);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem reads reject a file changed after inventory", async () => {
  const root = await workspace();
  try {
    await put(root, "file.ts");
    const scan = await scanFilesystem(root, undefined, 5_000);
    const fingerprint = scan.files.get("file.ts");
    assert.ok(fingerprint);
    assert.equal(
      (await readFilesystemFile(root, "file.ts", fingerprint)).data.toString("utf8"),
      "export const value = 1;\n",
    );

    await appendFile(join(root, "file.ts"), "export const grown = 2;\n");
    await assert.rejects(readFilesystemFile(root, "file.ts", fingerprint), /changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
