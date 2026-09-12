import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_DISCOVERY_FILE_BYTES = 128 * 1024;
const MAX_DISCOVERY_TOTAL_BYTES = 512 * 1024;
const MAX_MODULES = 32;
const MAX_MODULE_DEPTH = 6;
const MODULE_PATH = /^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$/;
const VARIANT = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_WORKSPACE_DEPTH = 4;
const MAX_WORKSPACE_ENTRIES = 2_048;
const MAX_WORKSPACE_DIRECTORIES = 512;
const MAX_PROJECT_CANDIDATES = 32;
const SKIPPED_DIRECTORIES = new Set([
  ".dart_tool",
  ".git",
  ".gradle",
  ".idea",
  ".pylon",
  "build",
  "dist",
  "ios",
  "node_modules",
  "src",
  "test",
  "tests",
  "vendor",
  "out",
]);

export interface AndroidWrapperIdentity {
  executablePath: string;
  executableRelativePath: "gradlew" | "gradlew.bat";
  fingerprint: string;
  files: Array<{ relativePath: string; sha256: string }>;
}

export interface AndroidProjectModuleSuggestion {
  modulePath: string;
  variants: string[];
}

export interface AndroidProjectDiscovery {
  canonicalRoot: string;
  settingsFile?: "settings.gradle" | "settings.gradle.kts";
  wrapper?: AndroidWrapperIdentity;
  modules: AndroidProjectModuleSuggestion[];
  issue?: string;
}

export type AndroidProjectKind = "gradle" | "flutter";

export interface AndroidProjectCandidate extends AndroidProjectDiscovery {
  candidateId: string;
  kind: AndroidProjectKind;
  label: string;
  workspaceRelativePath: string;
  androidRoot: string;
  artifactOutputRoot?: string;
  candidateRoot: string;
}

export interface AndroidWorkspaceDiscovery {
  canonicalRoot: string;
  candidates: AndroidProjectCandidate[];
  issue?: string;
}

export interface AndroidProjectDiscoveryOptions {
  platform?: NodeJS.Platform;
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function ordinaryFile(root: string, relativePath: string): Promise<string | undefined> {
  const candidate = resolve(root, relativePath);
  if (!contained(root, candidate)) throw new Error("Android project file escaped the workspace");
  try {
    const link = await lstat(candidate);
    if (!link.isFile() || link.isSymbolicLink()) return undefined;
    const canonical = await realpath(candidate);
    if (!contained(root, canonical)) return undefined;
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function boundedRead(path: string, budget: { bytes: number }): Promise<Buffer> {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("Android project input is not an ordinary file");
  if (file.size > MAX_DISCOVERY_FILE_BYTES || budget.bytes + file.size > MAX_DISCOVERY_TOTAL_BYTES) {
    throw new Error("Android project discovery exceeded its file-size limit");
  }
  const value = await readFile(path);
  if (value.byteLength !== file.size || value.byteLength > MAX_DISCOVERY_FILE_BYTES) {
    throw new Error("Android project input changed during discovery");
  }
  budget.bytes += value.byteLength;
  return value;
}

function withoutComments(source: string): string {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
      if (index >= source.length) throw new Error("Android Gradle script contains an unterminated comment");
      index++;
      output += " ";
      continue;
    }
    output += current;
  }
  if (quote) throw new Error("Android Gradle script contains an unterminated string");
  return output;
}
function stringRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let quote = "";
  let start = -1;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const current = source[index];
    if (!quote) {
      if (current === '"' || current === "'") {
        quote = current;
        start = index;
      }
      continue;
    }
    if (escaped) escaped = false;
    else if (current === "\\") escaped = true;
    else if (current === quote) {
      ranges.push({ start, end: index + 1 });
      quote = "";
    }
  }
  return ranges;
}

function syntaxOnly(source: string, ranges: Array<{ start: number; end: number }>): string {
  const characters = source.split("");
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index++) {
      if (characters[index] !== "\r" && characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

function parseIncludedModules(settings: string): string[] {
  const source = withoutComments(settings);
  const ranges = stringRanges(source);
  const syntax = syntaxOnly(source, ranges);
  if (/\b(?:includeBuild|includeFlat)\b|\.projectDir\b|\bproject\s*\([^)]*\)\s*\./.test(syntax)) {
    throw new Error("Composite or remapped Gradle modules are not supported");
  }
  const modules = new Set<string>();
  const includes = source.matchAll(/^\s*include\s*(?:\(([^()]*)\)|([^\r\n;]+))/gm);
  for (const match of includes) {
    if (match.index !== undefined && ranges.some(range => match.index! >= range.start && match.index! < range.end))
      continue;
    const body = match[1] ?? match[2] ?? "";
    const values = [...body.matchAll(/(["'])(.*?)\1/g)].map(item => item[2]);
    const remainder = body.replace(/(["'])(.*?)\1/g, "").replace(/[\s,]/g, "");
    if (!values.length || remainder) throw new Error("Dynamic Gradle module inclusion is not supported");
    for (const value of values) {
      const modulePath = value.startsWith(":") ? value : `:${value}`;
      if (!MODULE_PATH.test(modulePath) || modulePath.length > 160) throw new Error("Gradle module path is invalid");
      const segments = modulePath.slice(1).split(":").filter(Boolean);
      if (segments.length > MAX_MODULE_DEPTH || segments.some(segment => segment === "." || segment === "..")) {
        throw new Error("Gradle module path exceeds discovery limits");
      }
      modules.add(modulePath);
      if (modules.size > MAX_MODULES) throw new Error("Android project has too many included modules");
    }
  }
  return modules.size ? [...modules] : [":"];
}

function moduleDirectory(root: string, modulePath: string): string {
  return modulePath === ":" ? root : join(root, ...modulePath.slice(1).split(":"));
}

function applicationPlugin(source: string): boolean {
  const ranges = stringRanges(source);
  const matches = [
    ...source.matchAll(/\bid\s*(?:\(\s*)?["']com\.android\.application["']\s*\)?([^\r\n;}]*)/g),
    ...source.matchAll(/\bapply\s+plugin\s*:\s*["']com\.android\.application["']([^\r\n;}]*)/g),
  ];
  return matches.some(
    match =>
      match.index !== undefined &&
      !ranges.some(range => match.index! >= range.start && match.index! < range.end) &&
      !/\bapply\s+false\b/.test(match[1] ?? ""),
  );
}

function moduleVariants(source: string): string[] {
  if (/\b(?:productFlavors|flavorDimensions|androidComponents)\b/.test(source)) {
    throw new Error("Android product flavors and variant scripting require explicit future support");
  }
  return ["debug", "release"];
}

async function wrapperIdentity(
  root: string,
  platform: NodeJS.Platform,
  budget: { bytes: number },
): Promise<AndroidWrapperIdentity | undefined> {
  const executableRelativePath = platform === "win32" ? "gradlew.bat" : "gradlew";
  const required = [
    executableRelativePath,
    "gradle/wrapper/gradle-wrapper.jar",
    "gradle/wrapper/gradle-wrapper.properties",
  ];
  const optional = executableRelativePath === "gradlew" ? "gradlew.bat" : "gradlew";
  const paths: string[] = [];
  for (const relativePath of required) {
    const path = await ordinaryFile(root, relativePath);
    if (!path) return undefined;
    paths.push(relativePath);
  }
  if (await ordinaryFile(root, optional)) paths.push(optional);
  paths.sort();
  const files: Array<{ relativePath: string; sha256: string }> = [];
  for (const relativePath of paths) {
    const path = (await ordinaryFile(root, relativePath))!;
    const bytes = await boundedRead(path, budget);
    files.push({
      relativePath: relativePath.replaceAll("\\", "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (platform !== "win32") await access(resolve(root, executableRelativePath), constants.X_OK);
  const fingerprint = createHash("sha256")
    .update(files.map(file => `${file.relativePath}\0${file.sha256}`).join("\n"))
    .digest("hex");
  return { executablePath: resolve(root, executableRelativePath), executableRelativePath, fingerprint, files };
}

export function validAndroidModulePath(value: string): boolean {
  return (
    value.length <= 160 &&
    MODULE_PATH.test(value) &&
    !value.split(":").some(segment => segment === "." || segment === "..")
  );
}

export function validAndroidVariant(value: string): boolean {
  return VARIANT.test(value);
}

export async function discoverAndroidProject(
  root: string,
  options: AndroidProjectDiscoveryOptions = {},
): Promise<AndroidProjectDiscovery> {
  if (!isAbsolute(root) || root.length > 4096) throw new Error("Android workspace root is invalid");
  const canonicalRoot = await realpath(root);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Android workspace is unavailable");
  const budget = { bytes: 0 };
  try {
    const settingsCandidates = (
      await Promise.all(
        (["settings.gradle", "settings.gradle.kts"] as const).map(async relativePath => ({
          relativePath,
          path: await ordinaryFile(canonicalRoot, relativePath),
        })),
      )
    ).filter(candidate => candidate.path);
    if (settingsCandidates.length !== 1) {
      return {
        canonicalRoot,
        modules: [],
        issue: settingsCandidates.length
          ? "Multiple Gradle settings files are unsupported"
          : "Gradle settings file not found",
      };
    }
    const settings = settingsCandidates[0];
    const wrapper = await wrapperIdentity(canonicalRoot, options.platform ?? process.platform, budget);
    const included = parseIncludedModules((await boundedRead(settings.path!, budget)).toString("utf8"));
    const modules: AndroidProjectModuleSuggestion[] = [];
    for (const modulePath of included) {
      const directory = moduleDirectory(canonicalRoot, modulePath);
      const directoryState = await lstat(directory).catch(() => undefined);
      if (!directoryState?.isDirectory() || directoryState.isSymbolicLink()) continue;
      const canonicalDirectory = await realpath(directory).catch(() => undefined);
      if (!canonicalDirectory || !contained(canonicalRoot, canonicalDirectory)) continue;
      const scripts = (
        await Promise.all(
          (["build.gradle", "build.gradle.kts"] as const).map(async name =>
            ordinaryFile(canonicalRoot, relative(canonicalRoot, join(canonicalDirectory, name))),
          ),
        )
      ).filter((path): path is string => !!path);
      if (scripts.length !== 1) continue;
      const source = withoutComments((await boundedRead(scripts[0], budget)).toString("utf8"));
      if (!applicationPlugin(source)) continue;
      modules.push({ modulePath, variants: moduleVariants(source) });
    }
    return {
      canonicalRoot,
      settingsFile: settings.relativePath,
      wrapper,
      modules,
      ...(!wrapper
        ? { issue: "A complete Gradle wrapper was not found" }
        : !modules.length
          ? { issue: "No statically explicit Android application module was found" }
          : {}),
    };
  } catch (error) {
    const issue = error instanceof Error ? error.message.slice(0, 500) : "Android project discovery failed";
    return { canonicalRoot, modules: [], issue };
  }
}

function candidateId(kind: AndroidProjectKind, workspaceRelativePath: string): string {
  if (kind === "gradle" && workspaceRelativePath === ".") return "root";
  return createHash("sha256").update(`${kind}\0${workspaceRelativePath}`).digest("hex").slice(0, 32);
}

function candidateLabel(root: string, workspaceRelativePath: string): string {
  return workspaceRelativePath === "." ? basename(root) : workspaceRelativePath.replaceAll("\\", "/");
}

function flutterPubspec(source: string): boolean {
  const plain = source
    .split(/\r?\n/)
    .map(line => line.replace(/\s+#.*$/, ""))
    .join("\n");
  return /^\s*dependencies\s*:\s*$/m.test(plain) && /^\s+flutter\s*:\s*\n\s+sdk\s*:\s*flutter\s*$/m.test(plain);
}

function flutterIncludesApp(settings: string): boolean {
  const source = withoutComments(settings);
  if (/\bproject\s*\(\s*["']:app["']\s*\)\s*\.\s*projectDir\b/.test(source)) return false;
  return [...source.matchAll(/^\s*include\s*(?:\(([^()]*)\)|([^\r\n;]+))/gm)].some(match =>
    [...(match[1] ?? match[2] ?? "").matchAll(/(["'])(.*?)\1/g)].some(
      value => value[2] === ":app" || value[2] === "app",
    ),
  );
}

async function discoverFlutterProject(
  workspaceRoot: string,
  candidateRoot: string,
  workspaceRelativePath: string,
  platform: NodeJS.Platform,
  budget: { bytes: number },
): Promise<AndroidProjectCandidate> {
  const androidPath = resolve(candidateRoot, "android");
  const androidState = await lstat(androidPath).catch(() => undefined);
  const canonicalAndroid =
    androidState?.isDirectory() && !androidState.isSymbolicLink() ? await realpath(androidPath) : undefined;
  const base = {
    candidateId: candidateId("flutter", workspaceRelativePath),
    kind: "flutter" as const,
    label: candidateLabel(workspaceRoot, workspaceRelativePath),
    workspaceRelativePath,
    candidateRoot,
    canonicalRoot: canonicalAndroid ?? androidPath,
    androidRoot: canonicalAndroid ?? androidPath,
    artifactOutputRoot: resolve(candidateRoot, "build", "app", "outputs", "apk", "debug"),
    modules: [] as AndroidProjectModuleSuggestion[],
  };
  if (!canonicalAndroid || !contained(candidateRoot, canonicalAndroid) || !contained(workspaceRoot, canonicalAndroid)) {
    return { ...base, issue: "Flutter Android directory is unavailable or unsafe" };
  }
  try {
    const settings = (
      await Promise.all(
        (["settings.gradle", "settings.gradle.kts"] as const).map(async relativePath => ({
          relativePath,
          path: await ordinaryFile(canonicalAndroid, relativePath),
        })),
      )
    ).filter(candidate => candidate.path);
    if (settings.length !== 1) throw new Error("Flutter Android settings file is missing or ambiguous");
    if (!flutterIncludesApp((await boundedRead(settings[0].path!, budget)).toString("utf8"))) {
      throw new Error("Flutter Android app module is not statically included");
    }
    const scripts = (
      await Promise.all(
        (["app/build.gradle", "app/build.gradle.kts"] as const).map(path => ordinaryFile(canonicalAndroid, path)),
      )
    ).filter((path): path is string => !!path);
    if (scripts.length !== 1) throw new Error("Flutter Android app build script is missing or ambiguous");
    const appSource = withoutComments((await boundedRead(scripts[0], budget)).toString("utf8"));
    if (!applicationPlugin(appSource)) throw new Error("Flutter Android app plugin is not statically applied");
    moduleVariants(appSource);
    const wrapper = await wrapperIdentity(canonicalAndroid, platform, budget);
    if (!wrapper) throw new Error("A complete Flutter Android Gradle wrapper was not found");
    return {
      ...base,
      settingsFile: settings[0].relativePath,
      wrapper,
      modules: [{ modulePath: ":app", variants: ["debug"] }],
    };
  } catch (error) {
    return { ...base, issue: error instanceof Error ? error.message.slice(0, 500) : "Flutter discovery failed" };
  }
}

/** Bounded static workspace enumeration. It never runs Gradle or Flutter. */
export async function discoverAndroidWorkspace(
  root: string,
  options: AndroidProjectDiscoveryOptions = {},
): Promise<AndroidWorkspaceDiscovery> {
  if (!isAbsolute(root) || root.length > 4096) throw new Error("Android workspace root is invalid");
  const inputState = await lstat(root);
  if (!inputState.isDirectory() || inputState.isSymbolicLink())
    throw new Error("Android workspace root is unavailable");
  const canonicalRoot = await realpath(root);
  const platform = options.platform ?? process.platform;
  const budget = { bytes: 0 };
  const queue = [{ path: canonicalRoot, relativePath: ".", depth: 0 }];
  const candidates: AndroidProjectCandidate[] = [];
  let directories = 0;
  let entries = 0;
  try {
    while (queue.length) {
      const current = queue.shift()!;
      if (++directories > MAX_WORKSPACE_DIRECTORIES)
        throw new Error("Android workspace discovery exceeded its directory limit");
      const pubspec = await ordinaryFile(current.path, "pubspec.yaml");
      const androidSettings = await Promise.all([
        ordinaryFile(current.path, "android/settings.gradle"),
        ordinaryFile(current.path, "android/settings.gradle.kts"),
      ]);
      let isFlutter = false;
      let projectBoundary = false;
      if (pubspec && androidSettings.filter(Boolean).length === 1) {
        isFlutter = flutterPubspec((await boundedRead(pubspec, budget)).toString("utf8"));
        if (isFlutter) {
          projectBoundary = true;
          candidates.push(
            await discoverFlutterProject(canonicalRoot, current.path, current.relativePath, platform, budget),
          );
        }
      }
      if (!isFlutter) {
        const settings = await Promise.all([
          ordinaryFile(current.path, "settings.gradle"),
          ordinaryFile(current.path, "settings.gradle.kts"),
        ]);
        if (settings.filter(Boolean).length) {
          const discovery = await discoverAndroidProject(current.path, { platform });
          if (discovery.modules.length) {
            projectBoundary = true;
            candidates.push({
              ...discovery,
              candidateId: candidateId("gradle", current.relativePath),
              kind: "gradle",
              label: candidateLabel(canonicalRoot, current.relativePath),
              workspaceRelativePath: current.relativePath,
              candidateRoot: discovery.canonicalRoot,
              androidRoot: discovery.canonicalRoot,
            });
          }
        }
      }
      if (candidates.length > MAX_PROJECT_CANDIDATES) {
        throw new Error("Android workspace has too many project candidates");
      }
      if (projectBoundary || current.depth >= MAX_WORKSPACE_DEPTH) continue;
      for (const entry of (await readdir(current.path, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (++entries > MAX_WORKSPACE_ENTRIES) throw new Error("Android workspace discovery exceeded its entry limit");
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          entry.name.startsWith(".") ||
          SKIPPED_DIRECTORIES.has(entry.name)
        ) {
          continue;
        }
        if (isFlutter && entry.name === "android") continue;
        const child = join(current.path, entry.name);
        const childState = await lstat(child);
        if (!childState.isDirectory() || childState.isSymbolicLink()) continue;
        const canonicalChild = await realpath(child);
        if (!contained(canonicalRoot, canonicalChild)) throw new Error("Android workspace directory escaped its root");
        const relativePath = relative(canonicalRoot, canonicalChild).replaceAll("\\", "/");
        queue.push({ path: canonicalChild, relativePath, depth: current.depth + 1 });
      }
    }
    candidates.sort(
      (a, b) => a.workspaceRelativePath.localeCompare(b.workspaceRelativePath) || a.kind.localeCompare(b.kind),
    );
    return {
      canonicalRoot,
      candidates,
      ...(!candidates.length ? { issue: "No supported Android or Flutter application project was found" } : {}),
    };
  } catch (error) {
    return {
      canonicalRoot,
      candidates: [],
      issue: error instanceof Error ? error.message.slice(0, 500) : "Android workspace discovery failed",
    };
  }
}
