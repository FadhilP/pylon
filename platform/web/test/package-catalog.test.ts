import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackageCatalog } from "../src/server/pi/package-catalog.ts";

async function addPackage(root: string, id: string, extension = "./extension.ts"): Promise<void> {
  const packageRoot = join(root, "packages", id);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: id, description: `${id} description`, pi: { extensions: [extension] } }),
  );
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
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ pi: { extensions: ["./packages/pi-a/extension.ts", "./unmanaged.ts"] } }),
    );

    const catalog = new PackageCatalog(root, agentDir);
    const first = await catalog.scan();
    assert.deepEqual(
      first.packages.map(item => item.id),
      ["pi-a", "pi-b", "pylon-core"],
    );
    assert.deepEqual([...first.enabledIds].sort(), ["pi-a", "pylon-core"]);
    assert.equal(first.extensionPaths.length, 3);
    assert.ok(first.extensionPaths.some(path => path.endsWith("unmanaged.ts")));

    const enabled = await catalog.setEnabled("pi-b", true);
    assert.deepEqual([...enabled.enabledIds].sort(), ["pi-a", "pi-b", "pylon-core"]);

    await rm(join(root, "packages", "pi-b"), { recursive: true });
    assert.equal(
      (await catalog.scan()).packages.some(item => item.id === "pi-b"),
      false,
    );
    await addPackage(root, "pi-b");
    assert.equal((await catalog.scan()).enabledIds.has("pi-b"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package catalog keeps required core in a standalone repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-package-free-"));
  try {
    const state = await new PackageCatalog(root, join(root, "agent")).scan();
    assert.deepEqual(
      state.packages.map(item => item.id),
      ["pylon-core"],
    );
    assert.equal(state.enabledIds.has("pylon-core"), true);
    assert.equal(state.extensionPaths.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pylon-core is always enabled and cannot be disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-required-core-"));
  try {
    await addPackage(root, "pylon-core");
    const catalog = new PackageCatalog(root, join(root, "agent"));
    const state = await catalog.scan();
    assert.equal(state.packages[0]?.required, true);
    assert.equal(state.enabledIds.has("pylon-core"), true);
    await assert.rejects(catalog.setEnabled("pylon-core", false), /required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package catalog confines and delegates package-owned settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-package-settings-"));
  const packageRoot = join(root, "packages", "pi-settings");
  const agentDir = join(root, "agent");
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "extension.ts"), "export default () => {};\n");
    await writeFile(
      join(packageRoot, "settings.mjs"),
      `
      let current = { kind: "helios", headed: true };
      const expectedAgentDir = ${JSON.stringify(agentDir)};
      export async function readSettings(context) {
        if (context.agentDir !== expectedAgentDir) throw new Error("wrong agent directory");
        return current;
      }
      export async function updateSettings(value, context) {
        if (context.agentDir !== expectedAgentDir) throw new Error("wrong agent directory");
        current = value;
      }
    `,
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pi-settings",
        pi: { extensions: ["./extension.ts"] },
        pylon: { settings: "./settings.mjs" },
      }),
    );
    const catalog = new PackageCatalog(root, agentDir);
    const state = await catalog.scan();
    assert.ok(state.packages[0]?.settingsPath?.endsWith("settings.mjs"));
    assert.deepEqual(await catalog.readSettings("pi-settings", state), { kind: "helios", headed: true });
    const previous = await catalog.updateSettings("pi-settings", { kind: "helios", headed: false });
    assert.deepEqual(previous, { kind: "helios", headed: true });
    assert.deepEqual(await catalog.readSettings("pi-settings"), { kind: "helios", headed: false });

    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pi-settings",
        pi: { extensions: ["./extension.ts"] },
        pylon: { settings: "../../outside.mjs" },
      }),
    );
    await writeFile(join(root, "outside.mjs"), "export async function readSettings() {}\n");
    assert.equal((await catalog.scan()).packages[0]?.settingsPath, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
