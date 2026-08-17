import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isPylonPackageSource, PiExtensionManager, validPiPackageSource } from "../src/server/pi/pi-extension-manager.ts";
import { PackageCatalog } from "../src/server/pi/package-catalog.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pylon-extensions-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "user.ts"), "export default function () {}\n");
  await writeFile(join(cwd, ".pi", "extensions", "project.ts"), "export default function () {}\n");
  return { root, agentDir, cwd };
}

test("native extension inventory is rooted in Pylon agentDir and gates project resources", async () => {
  const { agentDir, cwd } = await fixture();
  const manager = new PiExtensionManager(cwd, agentDir);
  const initial = await manager.list(undefined, 1);
  assert.equal(initial.projectTrustRequired, true);
  assert.equal(initial.projectTrusted, false);
  assert.deepEqual(initial.extensions.map((item) => [item.scope, item.path]), [["user", "extensions/user.ts"]]);

  manager.setProjectTrusted(true);
  const trusted = new PiExtensionManager(cwd, agentDir);
  const listed = await trusted.list(undefined, 1);
  assert.equal(listed.projectTrusted, true);
  assert.deepEqual(listed.extensions.map((item) => [item.scope, item.path]), [
    ["project", "extensions/project.ts"],
    ["user", "extensions/user.ts"],
  ]);
});

test("native extension exact overrides preserve unrelated settings", async () => {
  const { agentDir, cwd } = await fixture();
  const manager = new PiExtensionManager(cwd, agentDir);
  manager.settings.setExtensionPaths(["!extensions/legacy.ts"]);
  await manager.settings.flush();
  const listed = await manager.list(undefined, 1);
  const user = listed.extensions.find((item) => item.scope === "user")!;
  await manager.setEnabled(user.id, false);
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.extensions, ["!extensions/legacy.ts", "-extensions/user.ts"]);

  await manager.setEnabled(user.id, true);
  const enabled = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(enabled.extensions, ["!extensions/legacy.ts", "+extensions/user.ts"]);
});

test("package extension overrides preserve package identity without exposing local absolute sources", async () => {
  const { root, agentDir, cwd } = await fixture();
  const packageRoot = join(root, "local-package");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "local-package", pi: { extensions: ["extensions/example.ts"] } }));
  await writeFile(join(packageRoot, "extensions", "example.ts"), "export default function () {}\n");
  const manager = new PiExtensionManager(cwd, agentDir);
  manager.settings.setPackages([packageRoot]);
  await manager.settings.flush();
  const listed = await manager.list(undefined, 1);
  const extension = listed.extensions.find((item) => item.origin === "package")!;
  assert.equal(extension.source, "local");
  assert.deepEqual(listed.packages, []);
  await manager.setEnabled(extension.id, false);
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [{ source: packageRoot, extensions: ["-extensions/example.ts"] }]);
});


test("bundled Pylon paths and package sources stay out of native extension settings", async () => {
  const { agentDir, cwd } = await fixture();
  const bundledPath = join(agentDir, "extensions", "user.ts");
  const manager = new PiExtensionManager(cwd, agentDir, undefined, [bundledPath]);
  manager.settings.setPackages(["npm:@fadhilp/pylon@1.9.1"]);
  await manager.settings.flush();
  const listed = await manager.list(undefined, 1);
  assert.deepEqual(listed.extensions, []);
  assert.deepEqual(listed.packages, []);
  assert.equal(isPylonPackageSource("npm:@fadhilp/pylon@1.9.1"), true);
  assert.equal(isPylonPackageSource("git:github.com/FadhilP/pylon@v1.9.1"), true);
  assert.equal(isPylonPackageSource("https://github.com/FadhilP/pylon.git"), true);
  assert.equal(isPylonPackageSource("npm:@fadhilp/other"), false);
});


test("the full Pylon catalog is excluded even when a native package is disabled", async () => {
  const { agentDir, cwd } = await fixture();
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const state = await new PackageCatalog(repositoryRoot, agentDir).scan();
  assert.equal(state.packages.some((item) => item.id === "pi-papercut"), true);
  const manager = new PiExtensionManager(cwd, agentDir, undefined, state.packages.flatMap((item) => item.extensionPaths));
  manager.settings.setPackages([repositoryRoot]);
  await manager.settings.flush();
  const listed = await manager.list(undefined, 1);
  assert.equal(listed.extensions.some((item) => item.path.includes("pi-papercut")), false);
  assert.equal(listed.extensions.some((item) => item.origin === "package"), false);
});


test("package source validation excludes local paths and shell-like input", () => {
  assert.equal(validPiPackageSource("npm:@scope/example@1.2.3"), true);
  assert.equal(validPiPackageSource("git:github.com/example/repo@v1"), true);
  assert.equal(validPiPackageSource("https://github.com/example/repo"), true);
  assert.equal(validPiPackageSource("./extension.ts"), false);
  assert.equal(validPiPackageSource("npm:pkg && calc"), false);
});
