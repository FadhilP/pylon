import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackageCatalog } from "../src/server/pi/package-catalog.ts";

async function addPackage(root: string, id: string, extension = "./extension.ts"): Promise<void> {
  const packageRoot = join(root, "packages", id);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: id,
    description: `${id} description`,
    pi: { extensions: [extension] },
  }));
  if (!extension.startsWith("..")) await writeFile(join(packageRoot, extension), "export default () => {};\n");
}

test("package catalog discovers safe packages and persists an allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-package-catalog-"));
  const agentDir = join(root, "agent");
  try {
    await Promise.all([
      addPackage(root, "pi-a"),
      addPackage(root, "pi-b"),
      addPackage(root, "pi-escape", "../outside.ts"),
    ]);
    await writeFile(join(root, "outside.ts"), "export default () => {};\n");
    await writeFile(join(root, "unmanaged.ts"), "export default () => {};\n");
    await writeFile(join(root, "package.json"), JSON.stringify({
      pi: { extensions: ["./packages/pi-a/extension.ts", "./unmanaged.ts"] },
    }));

    const catalog = new PackageCatalog(root, agentDir);
    const first = await catalog.scan();
    assert.deepEqual(first.packages.map((item) => item.id), ["pi-a", "pi-b"]);
    assert.deepEqual([...first.enabledIds], ["pi-a"]);
    assert.equal(first.extensionPaths.length, 2);
    assert.ok(first.extensionPaths.some((path) => path.endsWith("unmanaged.ts")));

    const enabled = await catalog.setEnabled("pi-b", true);
    assert.deepEqual([...enabled.enabledIds].sort(), ["pi-a", "pi-b"]);

    await rm(join(root, "packages", "pi-b"), { recursive: true });
    assert.equal((await catalog.scan()).packages.some((item) => item.id === "pi-b"), false);
    await addPackage(root, "pi-b");
    assert.equal((await catalog.scan()).enabledIds.has("pi-b"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package catalog supports a standalone repository with no manifest or packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-package-free-"));
  try {
    const state = await new PackageCatalog(root, join(root, "agent")).scan();
    assert.deepEqual(state.packages, []);
    assert.deepEqual(state.extensionPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
