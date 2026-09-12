import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validAndroidModulePath, validAndroidVariant } from "./project-discovery.js";
import type { AndroidExec, AndroidExecResult } from "./types.js";

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_APK_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_ENTRIES = 512;
const MAX_OUTPUT_DEPTH = 8;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const BUILD_TOOLS_VERSION = /^\d+(?:\.\d+){1,3}$/;
const SERIAL = /^(?!-)[A-Za-z0-9._:-]{1,128}$/;
const PID = /^[1-9]\d{0,9}$/;

export interface AndroidApkArtifact {
  readonly sourcePath: string;
  readonly metadataPath: string;
  readonly packageName: string;
  readonly variant: string;
  readonly sourceIdentity: FileIdentity;
}
export interface ApkDiscoveryInput {
  readonly workspaceRoot: string;
  readonly modulePath: string;
  readonly variant: string;
  readonly outputRoot?: string;
  readonly expectedOutputFile?: string;
}
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}
export interface StagedApkArtifact {
  readonly path: string;
  readonly sourcePath: string;
  readonly sourceIdentity: FileIdentity;
  readonly sha256: string;
  readonly bytes: number;
  cleanup(): Promise<void>;
  revalidate(): Promise<void>;
}
export interface AndroidBuildTools {
  readonly root: string;
  readonly version: string;
  readonly aapt2: string;
  readonly apksigner: string;
}
export interface InspectedApk {
  readonly packageName: string;
  readonly versionCode: string;
  readonly versionName: string;
  readonly minSdk: number;
  readonly targetSdk: number;
  readonly debuggable: boolean;
  readonly certificateSha256: string;
  readonly launchableComponent: string;
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return !!value && !value.startsWith("..") && !isAbsolute(value);
}
function moduleDirectory(root: string, modulePath: string): string {
  if (!isAbsolute(root) || !validAndroidModulePath(modulePath)) throw new Error("Android artifact location is invalid");
  return modulePath === ":" ? root : join(root, ...modulePath.slice(1).split(":"));
}

async function safeOutputDirectory(workspaceRoot: string, configured: string): Promise<string> {
  if (!isAbsolute(configured)) throw new Error("Android APK output root must be absolute");
  const root = await realpath(workspaceRoot);
  const target = resolve(configured);
  if (!within(root, target)) throw new Error("Android APK output path escapes workspace");
  let current = root;
  for (const segment of relative(root, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Android APK output path is unsafe");
  }
  const canonical = await realpath(target);
  if (canonical !== target || !within(root, canonical)) throw new Error("Android APK output path is unsafe");
  return canonical;
}
async function regular(path: string, label: string, maxBytes = MAX_APK_BYTES): Promise<FileIdentity> {
  const info = await lstat(path).catch(() => {
    throw new Error(`${label} is unavailable`);
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes)
    throw new Error(`${label} must be a bounded non-symlink regular file`);
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}
function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
async function metadataPaths(
  path: string,
  state = { entries: 0, paths: [] as string[] },
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_OUTPUT_DEPTH) throw new Error("Android APK output tree exceeds depth limit");
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Android APK output tree contains a symbolic link");
  if (!info.isDirectory()) return state.paths;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (++state.entries > MAX_OUTPUT_ENTRIES) throw new Error("Android APK output tree exceeds entry limit");
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Android APK output tree contains a symbolic link");
    if (entry.isDirectory()) await metadataPaths(child, state, depth + 1);
    else if (entry.isFile() && entry.name === "output-metadata.json") state.paths.push(child);
  }
  return state.paths;
}
async function parseMetadata(
  path: string,
  outputRoot: string,
): Promise<{ packageName: string; variant: string; outputFile: string }> {
  const canonicalBefore = await realpath(path).catch(() => "");
  if (canonicalBefore !== path || !within(outputRoot, canonicalBefore)) {
    throw new Error("Android output metadata path is unsafe");
  }
  const before = await regular(path, "Android output metadata", MAX_METADATA_BYTES);
  const text = await readFile(path, "utf8");
  const after = await regular(path, "Android output metadata", MAX_METADATA_BYTES);
  const canonicalAfter = await realpath(path).catch(() => "");
  if (canonicalAfter !== canonicalBefore || !sameIdentity(before, after) || Buffer.byteLength(text) !== before.size)
    throw new Error("Android output metadata changed while reading");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Android output metadata is malformed");
  }
  const value = parsed as { applicationId?: unknown; variantName?: unknown; elements?: unknown };
  if (
    typeof value.applicationId !== "string" ||
    !PACKAGE_ID.test(value.applicationId) ||
    typeof value.variantName !== "string" ||
    !validAndroidVariant(value.variantName) ||
    !Array.isArray(value.elements) ||
    value.elements.length !== 1
  ) {
    throw new Error("Android output metadata is malformed or ambiguous");
  }
  const element = value.elements[0] as { type?: unknown; filters?: unknown; outputFile?: unknown };
  if (
    element.type !== "SINGLE" ||
    !Array.isArray(element.filters) ||
    element.filters.length !== 0 ||
    typeof element.outputFile !== "string" ||
    !/^[^/\\\0]+\.apk$/.test(element.outputFile)
  ) {
    throw new Error("Android output metadata must describe one universal APK");
  }
  return { packageName: value.applicationId, variant: value.variantName, outputFile: element.outputFile };
}

/** Finds one AGP record for the requested variant; stale records for other variants are ignored. */
export async function discoverAndroidApk(input: ApkDiscoveryInput): Promise<AndroidApkArtifact> {
  if (!validAndroidVariant(input.variant)) throw new Error("Android build variant is invalid");
  if (input.expectedOutputFile && !/^[^/\\\0]+\.apk$/.test(input.expectedOutputFile)) {
    throw new Error("Android expected APK filename is invalid");
  }
  const root = await realpath(input.workspaceRoot);
  const configuredOutput = input.outputRoot ?? join(moduleDirectory(root, input.modulePath), "build", "outputs", "apk");
  const outputRoot = await safeOutputDirectory(root, configuredOutput);
  const metadataCandidates = input.expectedOutputFile
    ? [join(outputRoot, "output-metadata.json")]
    : await metadataPaths(outputRoot);
  const candidates: AndroidApkArtifact[] = [];
  for (const metadataPath of metadataCandidates) {
    const metadata = await parseMetadata(metadataPath, outputRoot);
    if (metadata.variant !== input.variant) continue;
    if (input.expectedOutputFile && metadata.outputFile !== input.expectedOutputFile) {
      throw new Error("Android APK output filename does not match the configured layout");
    }
    const sourcePath = resolve(join(metadataPath, "..", metadata.outputFile));
    if (!within(outputRoot, sourcePath)) throw new Error("Android APK output resolves outside configured module");
    const canonicalSource = await realpath(sourcePath).catch(() => "");
    if (canonicalSource !== sourcePath || !within(outputRoot, canonicalSource)) {
      throw new Error("Android APK output path is unsafe");
    }
    const sourceIdentity = await regular(sourcePath, "Android APK");
    candidates.push({
      sourcePath,
      sourceIdentity,
      metadataPath,
      packageName: metadata.packageName,
      variant: metadata.variant,
    });
  }
  if (candidates.length !== 1)
    throw new Error(`Android build must produce exactly one ${input.variant} APK metadata record`);
  return candidates[0];
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { flags: "r" });
    stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_APK_BYTES) stream.destroy(new Error("Android APK exceeds size limit"));
      else digest.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return { sha256: digest.digest("hex"), bytes };
}
async function safeDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Android staging directory must be absolute");
  let info = await lstat(path).catch(() => undefined);
  if (!info) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    info = await lstat(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Android staging directory is unsafe");
  const canonical = await realpath(path);
  await chmod(canonical, 0o700);
  return canonical;
}
export async function stageAndroidApk(
  sourcePath: string,
  stagingRoot: string,
  expectedIdentity?: FileIdentity,
): Promise<StagedApkArtifact> {
  if (!isAbsolute(sourcePath)) throw new Error("Android APK path must be absolute");
  const sourceIdentity = await regular(sourcePath, "Android APK");
  if (expectedIdentity && !sameIdentity(sourceIdentity, expectedIdentity)) {
    throw new Error("Android APK changed before staging");
  }
  const root = await safeDirectory(stagingRoot);
  const directory = join(root, `apk-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "artifact.apk");
  try {
    await copyFile(sourcePath, path);
    await chmod(path, 0o600);
    const [source, staged, after] = await Promise.all([
      hashFile(sourcePath),
      hashFile(path),
      regular(sourcePath, "Android APK"),
    ]);
    if (!sameIdentity(sourceIdentity, after) || source.sha256 !== staged.sha256 || source.bytes !== staged.bytes)
      throw new Error("Android APK changed while staging");
    const cleanup = async () => {
      const info = await lstat(directory).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        await unlink(directory);
        return;
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 0 });
    };
    return {
      path,
      sourcePath,
      sourceIdentity,
      sha256: staged.sha256,
      bytes: staged.bytes,
      cleanup,
      revalidate: async () => {
        const current = await regular(sourcePath, "Android APK");
        const copied = await regular(path, "staged Android APK");
        const [originalHash, stagedHash] = await Promise.all([hashFile(sourcePath), hashFile(path)]);
        if (
          !sameIdentity(sourceIdentity, current) ||
          originalHash.sha256 !== staged.sha256 ||
          stagedHash.sha256 !== staged.sha256 ||
          copied.size !== staged.bytes
        )
          throw new Error("Android APK changed before installation");
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 0 }).catch(() => undefined);
    throw error;
  }
}
/** Cleans only owned names; link entries are unlinked rather than traversed. */
export async function cleanupStaleAndroidStaging(stagingRoot: string): Promise<void> {
  const root = await safeDirectory(stagingRoot);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith("apk-")) continue;
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) await unlink(path);
    else if (info.isDirectory()) await rm(path, { recursive: true, force: true, maxRetries: 0 });
  }
}
function versionParts(version: string): number[] {
  return version.split(".").map(Number);
}
function compareVersions(a: string, b: string): number {
  const x = versionParts(a),
    y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}
async function tool(root: string, name: "aapt2" | "apksigner", platform: NodeJS.Platform): Promise<string> {
  const suffix = platform === "win32" ? (name === "aapt2" ? ".exe" : ".bat") : "";
  const path = join(root, name + suffix);
  await regular(path, `Android Build Tools ${name}`, 64 * 1024 * 1024);
  const canonical = await realpath(path);
  if (!within(root, canonical)) throw new Error("Android Build Tools executable resolves outside SDK");
  return canonical;
}
/** Resolves a requested version or the newest complete non-link Build Tools directory. */
export async function resolveAndroidBuildTools(
  sdkRoot: string,
  version?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<AndroidBuildTools> {
  if (!isAbsolute(sdkRoot) || (version !== undefined && !BUILD_TOOLS_VERSION.test(version)))
    throw new Error("Android Build Tools version is invalid");
  const root = await realpath(sdkRoot);
  const base = join(root, "build-tools");
  const versions = version
    ? [version]
    : (await readdir(base, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && BUILD_TOOLS_VERSION.test(entry.name))
        .map(entry => entry.name)
        .sort(compareVersions)
        .reverse();
  for (const candidate of versions) {
    const directory = join(base, candidate);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink() || !within(root, directory)) continue;
    try {
      return {
        root: directory,
        version: candidate,
        aapt2: await tool(directory, "aapt2", platform),
        apksigner: await tool(directory, "apksigner", platform),
      };
    } catch {
      if (version) throw new Error("Android Build Tools are incomplete or unsafe");
    }
  }
  throw new Error("Android Build Tools are unavailable");
}
function checked(label: string, result: AndroidExecResult): string {
  if (result.killed || result.code !== 0) throw new Error(`${label} failed`);
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_COMMAND_OUTPUT_BYTES)
    throw new Error(`${label} output exceeds limit`);
  return result.stdout;
}
function sdk(value: string, label: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) > 100_000) throw new Error(`Android APK ${label} is invalid`);
  return Number(value);
}
/** Inspects a staged copy only and optionally binds it to AGP's applicationId. */
export async function inspectAndroidApk(
  staged: Pick<StagedApkArtifact, "path">,
  tools: AndroidBuildTools,
  exec: AndroidExec,
  signal?: AbortSignal,
  expectedPackageName?: string,
): Promise<InspectedApk> {
  await regular(staged.path, "staged Android APK");
  if (signal?.aborted) throw new Error("Android APK inspection was cancelled");
  const badging = checked(
    "aapt2 dump badging",
    await exec(tools.aapt2, ["dump", "badging", staged.path], {
      signal,
      timeout: 20_000,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    }),
  );
  const signing = checked(
    "apksigner verify",
    await exec(tools.apksigner, ["verify", "--print-certs", staged.path], {
      signal,
      timeout: 20_000,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    }),
  );
  const packageMatch = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']*)'/m),
    min = badging.match(/^sdkVersion:'(\d+)'$/m),
    target = badging.match(/^targetSdkVersion:'(\d+)'$/m),
    launch = badging.match(/^launchable-activity: name='([^']+)'/m);
  if (
    !packageMatch ||
    !PACKAGE_ID.test(packageMatch[1]) ||
    !packageMatch[2] ||
    !min ||
    !target ||
    !launch ||
    !/^(?:\.)?[A-Za-z_][A-Za-z0-9_.$]*$/.test(launch[1]) ||
    (expectedPackageName !== undefined && packageMatch[1] !== expectedPackageName)
  )
    throw new Error("Android APK badging is malformed or does not match AGP metadata");
  if ((badging.match(/^launchable-activity:/gm) ?? []).length !== 1)
    throw new Error("Android APK has ambiguous launchable activities");
  const signerIds = [...new Set([...signing.matchAll(/^Signer #(\d+) certificate /gm)].map(match => match[1]))];
  const signerDigests = [...signing.matchAll(/^Signer #(\d+) certificate SHA-256 digest: ([0-9A-Fa-f:]{64,95})$/gm)];
  if (signerIds.length !== 1 || signerIds[0] !== "1" || signerDigests.length !== 1 || signerDigests[0][1] !== "1")
    throw new Error("Android APK must have exactly one SHA-256 signer");
  const certificateSha256 = signerDigests[0][2].replace(/:/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(certificateSha256)) throw new Error("Android APK signer digest is malformed");
  return {
    packageName: packageMatch[1],
    versionCode: packageMatch[2],
    versionName: packageMatch[3],
    minSdk: sdk(min[1], "min SDK"),
    targetSdk: sdk(target[1], "target SDK"),
    debuggable: /^application-debuggable$/m.test(badging),
    certificateSha256,
    launchableComponent: `${packageMatch[1]}/${launch[1].startsWith(".") ? packageMatch[1] + launch[1] : launch[1]}`,
  };
}
export class AndroidAppDevice {
  constructor(
    readonly adb: string,
    private readonly exec: AndroidExec,
  ) {}
  private async run(serial: string, args: string[], signal?: AbortSignal): Promise<string> {
    if (!SERIAL.test(serial)) throw new Error("Android device serial is invalid");
    return checked(
      "adb",
      await this.exec(this.adb, ["-s", serial, ...args], {
        signal,
        timeout: 20_000,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      }),
    );
  }
  async isPackageInstalled(serial: string, packageName: string, signal?: AbortSignal): Promise<boolean> {
    validatePackage(packageName);
    const value = (await this.run(serial, ["shell", "pm", "path", packageName], signal)).trim();
    if (!value) return false;
    if (!value.split(/\r?\n/).every(line => /^package:\S+$/.test(line)))
      throw new Error("Android package query is malformed");
    return true;
  }
  async install(serial: string, stagedPath: string, signal?: AbortSignal): Promise<void> {
    if (!isAbsolute(stagedPath)) throw new Error("staged Android APK path must be absolute");
    await regular(stagedPath, "staged Android APK");
    await this.run(serial, ["install", "-r", stagedPath], signal);
  }
  async installationIdentity(serial: string, packageName: string, signal?: AbortSignal): Promise<string> {
    validatePackage(packageName);
    const paths = (await this.run(serial, ["shell", "pm", "path", packageName], signal))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.match(/^package:(\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk)$/)?.[1]);
    if (!paths.length || paths.length > 32 || paths.some(path => !path || path.includes("/../"))) {
      throw new Error("Installed Android package paths are unavailable or unsafe");
    }
    const entries: string[] = [];
    for (const path of [...new Set(paths as string[])].sort()) {
      const output = (await this.run(serial, ["shell", "sha256sum", path], signal)).trim();
      const match = output.match(/^([0-9a-fA-F]{64})\s+\S+$/);
      if (!match) throw new Error("Installed Android package identity is malformed");
      entries.push(`${path}\0${match[1].toLowerCase()}`);
    }
    return createHash("sha256")
      .update(`${packageName}\0${entries.join("\0")}`)
      .digest("hex");
  }
  async launch(serial: string, component: string, signal?: AbortSignal): Promise<void> {
    validateComponent(component);
    await this.run(serial, ["shell", "am", "start", "-n", component], signal);
  }
  async forceStop(serial: string, packageName: string, signal?: AbortSignal): Promise<void> {
    validatePackage(packageName);
    await this.run(serial, ["shell", "am", "force-stop", packageName], signal);
  }
  async packagePids(serial: string, packageName: string, signal?: AbortSignal): Promise<number[]> {
    validatePackage(packageName);
    const result: number[] = [];
    for (const line of (await this.run(serial, ["shell", "ps", "-A", "-o", "PID,NAME"], signal))
      .split(/\r?\n/)
      .slice(1)) {
      if (!line.trim()) continue;
      const match = line.trim().match(/^(\d+)\s+(\S+)$/);
      if (!match) throw new Error("Android process listing is malformed");
      if (match[2] === packageName || match[2].startsWith(`${packageName}:`)) {
        if (!PID.test(match[1]) || Number(match[1]) > 2_147_483_647 || result.length >= 4_096)
          throw new Error("Android process listing exceeds PID limit");
        result.push(Number(match[1]));
      }
    }
    return [...new Set(result)].sort((a, b) => a - b);
  }
}
function validatePackage(value: string): void {
  if (!PACKAGE_ID.test(value)) throw new Error("Android package name is invalid");
}
function validateComponent(value: string): void {
  const match = value.match(/^([^/]+)\/([^/]+)$/);
  if (!match) throw new Error("Android component is invalid");
  validatePackage(match[1]);
  if (!/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(match[2])) throw new Error("Android component is invalid");
}
