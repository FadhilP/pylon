import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export type Check = { id: string; label: string; command: string; args: string[]; cwd: string };
export type Detection = { checks: Check[]; available: Check[]; omitted: Check[]; packageRoots: string[] };

const LIMIT = 6;
const npmScripts = ["verify", "check", "typecheck", "lint", "test"];
const composerScripts = ["verify", "check", "analyse", "analyze", "lint", "test"];
const namedTargets = ["verify", "check", "test", "lint"];
const ignoredChildren = new Set(["build", "dist", "node_modules", "out", "target", "vendor"]);

async function text(path: string) {
  return readFile(path, "utf8").catch(() => undefined);
}

async function exists(path: string) {
  return (await text(path)) !== undefined;
}

function declaredScript(value: unknown) {
  return typeof value === "string" || Array.isArray(value);
}

function targetDeclared(source: string, target: string) {
  return new RegExp(`^${target}\\s*:`, "m").test(source);
}

async function wrappedCommand(cwd: string, unix: string, windows: string, global: string, args: string[]) {
  if (process.platform === "win32" && (await exists(join(cwd, windows))))
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", windows, ...args] };
  if (process.platform !== "win32" && (await exists(join(cwd, unix)))) return { command: `./${unix}`, args };
  return { command: global, args };
}

async function isDotnetTestProject(path: string) {
  const project = await text(path);
  return (
    project !== undefined &&
    (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(project) || /Microsoft\.NET\.Test\.Sdk/i.test(project))
  );
}

function hasPubDependency(source: string, name: string) {
  let dependenciesIndent: number | undefined;
  for (const line of source.split(/\r?\n/)) {
    const section = line.match(/^(\s*)(?:dependencies|dev_dependencies)\s*:/);
    if (section) {
      dependenciesIndent = section[1].length;
      continue;
    }
    if (dependenciesIndent === undefined) continue;
    const indent = line.match(/^(\s*)/)![1].length;
    if (line.trim() && indent <= dependenciesIndent) dependenciesIndent = undefined;
    else if (new RegExp(`^\\s+${name}\\s*:`).test(line)) return true;
  }
  return false;
}

const gradlePlugin =
  /(?:\bid\s*\(?\s*["'](?:java|java-library|org\.jetbrains\.kotlin\.(?:jvm|android)|com\.android\.[^"']+)["']\s*\)?|\bkotlin\s*\(\s*["'](?:jvm|android)["']\s*\)|\bapply\s+plugin\s*:\s*["'](?:java|java-library|org\.jetbrains\.kotlin\.(?:jvm|android)|com\.android\.[^"']+)["']|\bplugins\s*\{[^}]*\b(?:java|java-library)\b)/;
const rubyTask = (target: string) =>
  new RegExp(
    `(?:\\btask\\s*(?:\\(\\s*)?(?::${target}\\b|["']${target}["']|${target}\\s*:)|\\b(?:TestTask|RakeTask)\\.new\\s*\\(\\s*(?::${target}\\b|["']${target}["']))`,
  );

type AddCheck = (id: string, label: string, command: string, args: string[]) => void;

/** Prefers whole solutions that contain a test project; otherwise falls back to loose .csproj files. */
async function detectDotnet(cwd: string, files: string[], add: AddCheck) {
  let testSolution = false;
  for (const name of files.filter(file => /\.slnx?$/i.test(file))) {
    const solution = (await text(join(cwd, name))) ?? "";
    const projects = [...solution.matchAll(/["']([^"']+\.csproj)["']/gi)].map(match => match[1].replaceAll("\\", "/"));
    if ((await Promise.all(projects.map(project => isDotnetTestProject(join(cwd, project))))).some(Boolean)) {
      add(`dotnet:test:${name}`, `dotnet test ${name}`, "dotnet", ["test", name]);
      testSolution = true;
    }
  }
  if (testSolution) return;
  for (const name of files.filter(file => file.endsWith(".csproj")))
    if (await isDotnetTestProject(join(cwd, name)))
      add(`dotnet:test:${name}`, `dotnet test ${name}`, "dotnet", ["test", name]);
}

/** Stack owns the build when stack.yaml exists, so only bare Cabal projects get a check. */
async function detectCabal(cwd: string, files: string[], add: AddCheck) {
  if (await exists(join(cwd, "stack.yaml"))) return;
  for (const name of files.filter(file => file.endsWith(".cabal"))) {
    const cabal = await text(join(cwd, name));
    if (cabal !== undefined && /^\s*test-suite\s+/im.test(cabal)) {
      add(`haskell:cabal-test:${name}`, "cabal test all", "cabal", ["test", "all"]);
      return;
    }
  }
}

async function detectRake(cwd: string, add: AddCheck) {
  const rakefile = await text(join(cwd, "Rakefile"));
  if (rakefile === undefined) return;
  for (const target of ["test", "spec"])
    if (rubyTask(target).test(rakefile)) {
      const bundled = await exists(join(cwd, "Gemfile"));
      add(
        `ruby:${target}`,
        bundled ? `bundle exec rake ${target}` : `rake ${target}`,
        bundled ? "bundle" : "rake",
        bundled ? ["exec", "rake", target] : [target],
      );
    }
}

async function checksAt(cwd: string, prefix = ""): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, label: string, command: string, args: string[]) =>
    checks.push({
      id: `${prefix}${id}`,
      label: prefix ? `${prefix.slice(0, -1)}: ${label}` : label,
      command,
      args,
      cwd,
    });
  const addStandard = async (id: string, label: string, file: string, command: string, args: string[]) => {
    if (await exists(join(cwd, file))) add(id, label, command, args);
  };

  const packageText = await text(join(cwd, "package.json"));
  if (packageText !== undefined) {
    try {
      const scripts = JSON.parse(packageText)?.scripts ?? {};
      for (const name of npmScripts)
        if (typeof scripts[name] === "string") {
          const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
          const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm", "run", name] : ["run", name];
          add(`npm:${name}`, `npm ${name}`, command, args);
        }
    } catch {}
  }

  const composerText = await text(join(cwd, "composer.json"));
  if (composerText !== undefined) {
    try {
      const scripts = JSON.parse(composerText)?.scripts ?? {};
      for (const name of composerScripts)
        if (declaredScript(scripts[name]))
          add(`composer:${name}`, `composer ${name}`, "composer", ["run-script", name]);
    } catch {}
  }

  const denoText = await text(join(cwd, "deno.json"));
  if (denoText !== undefined) {
    try {
      const tasks = JSON.parse(denoText)?.tasks ?? {};
      for (const name of npmScripts)
        if (typeof tasks[name] === "string") add(`deno:${name}`, `deno ${name}`, "deno", ["task", name]);
    } catch {}
  }

  const pyproject = await text(join(cwd, "pyproject.toml"));
  if (pyproject !== undefined) {
    if (/^\s*\[tool\.ruff(?:\.|\])/m.test(pyproject))
      add("python:ruff", "ruff", "python", ["-m", "ruff", "check", "."]);
    if (/^\s*\[tool\.mypy(?:\.|\])/m.test(pyproject)) add("python:mypy", "mypy", "python", ["-m", "mypy", "."]);
    if (/^\s*\[tool\.pytest(?:\.|\])/m.test(pyproject)) add("python:pytest", "pytest", "python", ["-m", "pytest"]);
    if (/^\s*\[tool\.tox(?:\.|\])/m.test(pyproject)) add("python:tox", "tox", "tox", []);
  }
  if (await exists(join(cwd, "tox.ini"))) add("python:tox", "tox", "tox", []);
  if (await exists(join(cwd, "noxfile.py"))) add("python:nox", "nox", "nox", []);

  if (await exists(join(cwd, "Cargo.toml"))) add("rust:test", "cargo test", "cargo", ["test"]);
  if (await exists(join(cwd, "go.mod"))) add("go:test", "go test", "go", ["test", "./..."]);

  if (await exists(join(cwd, "pom.xml"))) {
    const check = await wrappedCommand(cwd, "mvnw", "mvnw.cmd", "mvn", ["test"]);
    add("maven:test", "mvn test", check.command, check.args);
  }

  const gradleText = (await Promise.all(["build.gradle", "build.gradle.kts"].map(file => text(join(cwd, file)))))
    .filter((value): value is string => value !== undefined)
    .join("\n");
  if (gradleText && gradlePlugin.test(gradleText)) {
    const check = await wrappedCommand(cwd, "gradlew", "gradlew.bat", "gradle", ["test"]);
    add("gradle:test", "gradle test", check.command, check.args);
  }

  const makefile = await text(join(cwd, "Makefile"));
  if (makefile !== undefined)
    for (const target of namedTargets)
      if (targetDeclared(makefile, target)) add(`make:${target}`, `make ${target}`, "make", [target]);

  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
  await detectDotnet(cwd, files, add);

  await addStandard("elixir:test", "mix test", "mix.exs", "mix", ["test"]);
  await addStandard("swift:test", "swift test", "Package.swift", "swift", ["test"]);
  await addStandard("scala:test", "sbt test", "build.sbt", "sbt", ["test"]);
  await addStandard("ocaml:test", "dune runtest", "dune-project", "dune", ["runtest"]);
  await addStandard("clojure:test", "lein test", "project.clj", "lein", ["test"]);
  await addStandard("gleam:test", "gleam test", "gleam.toml", "gleam", ["test"]);
  await addStandard("crystal:spec", "crystal spec", "shard.yml", "crystal", ["spec"]);
  await addStandard("nix:flake-check", "nix flake check", "flake.nix", "nix", ["flake", "check"]);
  await addStandard("haskell:stack-test", "stack test", "stack.yaml", "stack", ["test"]);
  await addStandard("erlang:eunit", "rebar3 eunit", "rebar.config", "rebar3", ["eunit"]);

  const pubspec = await text(join(cwd, "pubspec.yaml"));
  if (pubspec !== undefined) {
    if (hasPubDependency(pubspec, "flutter_test")) add("flutter:test", "flutter test", "flutter", ["test"]);
    else if (hasPubDependency(pubspec, "test")) add("dart:test", "dart test", "dart", ["test"]);
  }

  await detectCabal(cwd, files, add);

  const zig = await text(join(cwd, "build.zig"));
  if (zig !== undefined && /\b\w+\.step\s*\(\s*"test"\s*,/.test(zig))
    add("zig:test", "zig build test", "zig", ["build", "test"]);

  await detectRake(cwd, add);

  const justfile = (await text(join(cwd, "Justfile"))) ?? (await text(join(cwd, "justfile")));
  if (justfile !== undefined)
    for (const target of namedTargets)
      if (targetDeclared(justfile, target)) add(`just:${target}`, `just ${target}`, "just", [target]);

  return checks;
}

async function packageDirectories(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  const roots = entries
    .filter(item => item.isDirectory() && !item.name.startsWith(".") && !ignoredChildren.has(item.name))
    .map(item => resolve(cwd, item.name));
  const packageText = await text(join(cwd, "package.json"));
  if (packageText !== undefined) {
    try {
      const value = JSON.parse(packageText)?.workspaces;
      const patterns: unknown[] = Array.isArray(value) ? value : Array.isArray(value?.packages) ? value.packages : [];
      for (const pattern of patterns) {
        if (typeof pattern !== "string") continue;
        const normalized = pattern.replaceAll("\\", "/").replace(/\/$/, "");
        const segments = normalized.split("/");
        if (
          !normalized ||
          normalized.startsWith("!") ||
          segments.some(segment => !segment || segment === "." || segment === "..") ||
          segments.slice(0, -1).some(segment => segment.includes("*")) ||
          (segments.at(-1)!.includes("*") && segments.at(-1) !== "*")
        )
          continue;
        if (segments.at(-1) === "*") {
          const parent = resolve(cwd, ...segments.slice(0, -1));
          const children = await readdir(parent, { withFileTypes: true }).catch(() => []);
          roots.push(...children.filter(item => item.isDirectory()).map(item => resolve(parent, item.name)));
        } else {
          const root = resolve(cwd, ...segments);
          if (
            await stat(root).then(
              value => value.isDirectory(),
              () => false,
            )
          )
            roots.push(root);
        }
      }
    } catch {}
  }
  return [...new Set(roots)].sort((a, b) => a.localeCompare(b));
}

export async function detectChecks(cwd: string): Promise<Detection> {
  cwd = resolve(cwd);
  const rootChecks = await checksAt(cwd);
  const packageRoots = await packageDirectories(cwd);
  const packageChecks = (
    await Promise.all(packageRoots.map(root => checksAt(root, `${relative(cwd, root).replaceAll("\\", "/")}/`)))
  ).flat();
  let available = [...rootChecks, ...packageChecks];
  const seen = new Set<string>();
  available = available.filter(check => {
    const key = `${check.cwd}\0${check.command}\0${check.args.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const defaults = rootChecks.length ? available.filter(check => check.cwd === cwd) : available;
  const checks = defaults.slice(0, LIMIT);
  return { checks, available, omitted: defaults.slice(LIMIT), packageRoots };
}
