import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectChecks } from "../src/detect.ts";

const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArgs = (name: string) => process.platform === "win32"
  ? ["/d", "/s", "/c", "npm", "run", name]
  : ["run", name];
const fixture = (name: string) => mkdtemp(join(tmpdir(), `pi-verify-${name}-`));

test("detects only declared npm verification scripts in stable order", async () => {
  const root = await fixture("npm");
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: { test: "node --test", check: "tsc --noEmit", lint: ["not", "an npm script"], start: "node app" },
  }));
  assert.deepEqual((await detectChecks(root)).checks, [
    { id: "npm:check", label: "npm check", command: npmCommand, args: npmArgs("check"), cwd: root },
    { id: "npm:test", label: "npm test", command: npmCommand, args: npmArgs("test"), cwd: root },
  ]);
});

test("detects configured Python, Rust, Go, and Make checks", async () => {
  const root = await fixture("mixed");
  await writeFile(join(root, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n");
  await writeFile(join(root, "Cargo.toml"), "[package]\nname='x'\n");
  await writeFile(join(root, "go.mod"), "module example.test/x\n");
  await writeFile(join(root, "Makefile"), "check:\n\t@true\nrandom:\n\t@true\n");
  assert.deepEqual((await detectChecks(root)).checks.map((check) => check.label), [
    "ruff", "pytest", "cargo test", "go test", "make check",
  ]);
});

test("detects declared Composer and Deno manifest checks", async () => {
  const root = await fixture("manifests");
  await writeFile(join(root, "composer.json"), JSON.stringify({
    scripts: { verify: "php verify.php", analyze: ["phpstan", "psalm"], install: "composer install" },
  }));
  await writeFile(join(root, "deno.json"), JSON.stringify({
    tasks: { check: "deno check main.ts", test: "deno test", serve: "deno run main.ts" },
  }));
  const checks = (await detectChecks(root)).checks;
  assert.deepEqual(checks.map(({ id, command, args }) => ({ id, command, args })), [
    { id: "composer:verify", command: "composer", args: ["run-script", "verify"] },
    { id: "composer:analyze", command: "composer", args: ["run-script", "analyze"] },
    { id: "deno:check", command: "deno", args: ["task", "check"] },
    { id: "deno:test", command: "deno", args: ["task", "test"] },
  ]);
});

test("uses Maven and Gradle wrappers and rejects Gradle markers without JVM plugins", async () => {
  const root = await fixture("wrappers");
  await writeFile(join(root, "pom.xml"), "<project />\n");
  await writeFile(join(root, "build.gradle.kts"), "plugins { id(\"java\") }\n");
  await writeFile(join(root, process.platform === "win32" ? "mvnw.cmd" : "mvnw"), "");
  await writeFile(join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew"), "");
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : undefined;
  assert.deepEqual((await detectChecks(root)).checks.map(({ id, command, args }) => ({ id, command, args })), [
    { id: "maven:test", command: command ?? "./mvnw", args: process.platform === "win32" ? ["/d", "/s", "/c", "mvnw.cmd", "test"] : ["test"] },
    { id: "gradle:test", command: command ?? "./gradlew", args: process.platform === "win32" ? ["/d", "/s", "/c", "gradlew.bat", "test"] : ["test"] },
  ]);

  const markerOnly = await fixture("gradle-marker");
  await writeFile(join(markerOnly, "settings.gradle"), "pluginManagement { plugins { id('java') } }\n");
  await writeFile(join(markerOnly, "build.gradle"), "// java is mentioned but no plugin is declared\n");
  assert.deepEqual((await detectChecks(markerOnly)).checks, []);
});

test("detects standardized lifecycle checks from their project files", async () => {
  const cases = [
    { name: "elixir", file: "mix.exs", contents: "", expected: ["elixir:test", "mix", ["test"]] },
    { name: "nix", file: "flake.nix", contents: "{}", expected: ["nix:flake-check", "nix", ["flake", "check"]] },
    { name: "zig", file: "build.zig", contents: 'const step = b.step("test", "Run tests");', expected: ["zig:test", "zig", ["build", "test"]] },
  ] as const;
  for (const item of cases) {
    const root = await fixture(item.name);
    await writeFile(join(root, item.file), item.contents);
    const [check] = (await detectChecks(root)).checks;
    assert.deepEqual([check.id, check.command, check.args], item.expected);
  }
});

test("detects only .NET solutions containing confirmed test projects", async () => {
  const root = await fixture("dotnet");
  const tests = join(root, "tests");
  await mkdir(tests);
  await writeFile(join(tests, "App.Tests.csproj"), "<Project><PackageReference Include=\"Microsoft.NET.Test.Sdk\" /></Project>");
  await writeFile(join(root, "a.slnx"), "<Solution><Project Path=\"tests/App.Tests.csproj\" /></Solution>");
  await writeFile(join(root, "z.sln"), "Project(\"id\") = \"App.Tests\", \"tests\\App.Tests.csproj\", \"id\"");
  await writeFile(join(root, "NameOnly.Tests.csproj"), "<Project />");
  assert.deepEqual((await detectChecks(root)).checks.map(({ id, command, args }) => ({ id, command, args })), [
    { id: "dotnet:test:a.slnx", command: "dotnet", args: ["test", "a.slnx"] },
    { id: "dotnet:test:z.sln", command: "dotnet", args: ["test", "z.sln"] },
  ]);
});

test("discovers all immediate non-hidden child directories with the same detectors", async () => {
  const root = await fixture("children");
  const child = join(root, "service");
  const hidden = join(root, ".hidden");
  const generated = join(root, "node_modules");
  await mkdir(child);
  await mkdir(hidden);
  await mkdir(generated);
  await writeFile(join(child, "deno.json"), JSON.stringify({ tasks: { test: "deno test" } }));
  await writeFile(join(hidden, "mix.exs"), "");
  await writeFile(join(generated, "mix.exs"), "");
  assert.deepEqual((await detectChecks(root)).checks.map((check) => check.id), ["service/deno:test"]);
});

test("reports six-check cap for immediate child packages", async () => {
  const root = await fixture("cap");
  for (const name of ["a", "b", "c", "d"]) {
    const child = join(root, name);
    await mkdir(child);
    await writeFile(join(child, "package.json"), JSON.stringify({ scripts: { check: "true", test: "true" } }));
  }
  const detected = await detectChecks(root);
  assert.deepEqual(detected.checks.map((check) => check.id), [
    "a/npm:check", "a/npm:test", "b/npm:check", "b/npm:test", "c/npm:check", "c/npm:test",
  ]);
  assert.deepEqual(detected.omitted.map((check) => check.id), ["d/npm:check", "d/npm:test"]);
});
