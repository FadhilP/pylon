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
      let current = { kind: "generic", packageId: "pi-settings", fields: [{ version: 1, key: "enabled", label: "Enabled", type: "boolean", defaultValue: true, value: true, apply: "immediate" }] };
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
    assert.deepEqual(await catalog.readSettings("pi-settings", state), {
      kind: "generic",
      packageId: "pi-settings",
      fields: [
        {
          version: 1,
          key: "enabled",
          label: "Enabled",
          type: "boolean",
          defaultValue: true,
          value: true,
          apply: "immediate",
        },
      ],
    });
    const next = {
      kind: "generic" as const,
      packageId: "pi-settings",
      fields: [
        {
          version: 1 as const,
          key: "enabled",
          label: "Enabled",
          type: "boolean" as const,
          defaultValue: true,
          value: false,
          apply: "immediate" as const,
        },
      ],
    };
    const previous = await catalog.updateSettings("pi-settings", next);
    assert.deepEqual(previous, {
      kind: "generic",
      packageId: "pi-settings",
      fields: [
        {
          version: 1,
          key: "enabled",
          label: "Enabled",
          type: "boolean",
          defaultValue: true,
          value: true,
          apply: "immediate",
        },
      ],
    });
    assert.deepEqual(await catalog.readSettings("pi-settings"), next);

    await assert.rejects(
      catalog.updateSettings("pi-settings", { kind: "generic", packageId: "pi-other", fields: [] }),
      /packageId does not match/,
    );

    const invalidRoot = join(root, "packages", "pi-invalid-generic");
    await mkdir(invalidRoot, { recursive: true });
    await writeFile(join(invalidRoot, "extension.ts"), "export default () => {};\n");
    await writeFile(
      join(invalidRoot, "settings.mjs"),
      `export async function readSettings() { return { kind: "generic", packageId: "pi-invalid-generic", fields: [{ version: 1, key: "enabled", label: "Enabled", type: "boolean", defaultValue: true, value: true, apply: "immediate", callback: "not data" }] }; }
       export async function updateSettings() {}`,
    );
    await writeFile(
      join(invalidRoot, "package.json"),
      JSON.stringify({
        name: "pi-invalid-generic",
        pi: { extensions: ["./extension.ts"] },
        pylon: { settings: "./settings.mjs" },
      }),
    );
    await assert.rejects(catalog.readSettings("pi-invalid-generic"), /returned invalid settings/);

    const mismatchRoot = join(root, "packages", "pi-mismatch-generic");
    await mkdir(mismatchRoot, { recursive: true });
    await writeFile(join(mismatchRoot, "extension.ts"), "export default () => {};\n");
    await writeFile(
      join(mismatchRoot, "settings.mjs"),
      `export async function readSettings() { return { kind: "generic", packageId: "pi-other", fields: [{ version: 1, key: "enabled", label: "Enabled", type: "boolean", defaultValue: true, value: true, apply: "immediate" }] }; }
       export async function updateSettings() {}`,
    );
    await writeFile(
      join(mismatchRoot, "package.json"),
      JSON.stringify({
        name: "pi-mismatch-generic",
        pi: { extensions: ["./extension.ts"] },
        pylon: { settings: "./settings.mjs" },
      }),
    );
    await assert.rejects(catalog.readSettings("pi-mismatch-generic"), /returned invalid settings/);

    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pi-settings",
        pi: { extensions: ["./extension.ts"] },
        pylon: { settings: "../../outside.mjs" },
      }),
    );
    await writeFile(join(root, "outside.mjs"), "export async function readSettings() {}\n");
    assert.equal((await catalog.scan()).packages.find(item => item.id === "pi-settings")?.settingsPath, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
