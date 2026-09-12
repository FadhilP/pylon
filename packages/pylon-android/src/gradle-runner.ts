import { spawn } from "node:child_process";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import {
  discoverAndroidProject,
  discoverAndroidWorkspace,
  validAndroidModulePath,
  validAndroidVariant,
} from "./project-discovery.js";
import { terminateProcessTree } from "./process.js";
import type { AndroidProcessTerminator, AndroidSpawn } from "./types.js";

const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60_000;
const MAX_BUILD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SAFE_WINDOWS_WRAPPER_PATH = /^[^"%!^&|<>()\r\n]+$/;

export interface AuthorizedAndroidWorkspace {
  canonicalRoot: string;
  wrapperPath: string;
  wrapperFingerprint: string;
  modulePath: string;
  variant: string;
  kind?: "gradle" | "flutter";
  discoveryRoot?: string;
  candidateId?: string;
}

export interface AndroidGradleBuildInput {
  workspace: AuthorizedAndroidWorkspace;
  stateDirectory: string;
  signal?: AbortSignal;
  forceRerun?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onOutput?: (chunk: string, truncated: boolean) => void;
}

export interface AndroidGradleBuildResult {
  task: string;
  code: number;
  succeeded: boolean;
  cancelled: boolean;
  timedOut: boolean;
  output: string;
  truncated: boolean;
}

export interface AndroidGradleRunnerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: AndroidSpawn;
  terminateProcess?: AndroidProcessTerminator;
}

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function taskFor(modulePath: string, variant: string): string {
  if (!validAndroidModulePath(modulePath) || !validAndroidVariant(variant)) {
    throw new Error("Android build configuration is invalid");
  }
  const assemble = `assemble${variant[0].toUpperCase()}${variant.slice(1)}`;
  return modulePath === ":" ? assemble : `${modulePath}:${assemble}`;
}

export function sanitizedGradleEnvironment(source: NodeJS.ProcessEnv, gradleUserHome: string): NodeJS.ProcessEnv {
  const allowed = new Map(
    [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "JAVA_HOME",
      "ANDROID_HOME",
      "ANDROID_SDK_ROOT",
      "PATHEXT",
      "COMSPEC",
    ].map(key => [key.toUpperCase(), key] as const),
  );
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const canonical = allowed.get(key.toUpperCase());
    if (value !== undefined && canonical && result[canonical] === undefined) result[canonical] = value;
  }
  result.GRADLE_USER_HOME = gradleUserHome;
  return result;
}

export function androidGradleInvocation(
  platform: NodeJS.Platform,
  wrapperPath: string,
  task: string,
  env: NodeJS.ProcessEnv,
  forceRerun = false,
): { executable: string; args: string[] } {
  const args = [task, "--no-daemon", "--console=plain", ...(forceRerun ? ["--rerun-tasks"] : [])];
  if (platform !== "win32") return { executable: wrapperPath, args };
  if (!SAFE_WINDOWS_WRAPPER_PATH.test(wrapperPath)) {
    throw new Error("Android workspace path is unsupported for safe Windows Gradle execution");
  }
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
  if (!root || !win32.isAbsolute(root)) throw new Error("Windows system directory is unavailable");
  const executable = win32.join(root, "System32", "cmd.exe");
  return { executable, args: ["/d", "/v:off", "/s", "/c", `"\"${wrapperPath}\" ${args.join(" ")}"`] };
}
function safeBuildOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
}

export async function runAndroidGradleBuild(
  input: AndroidGradleBuildInput,
  options: AndroidGradleRunnerOptions = {},
): Promise<AndroidGradleBuildResult> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = boundedInteger(input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS, MAX_BUILD_TIMEOUT_MS, "Build timeout");
  const maxOutputBytes = boundedInteger(
    input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    MAX_OUTPUT_BYTES,
    "Build output limit",
  );
  if (!isAbsolute(input.workspace.canonicalRoot) || !isAbsolute(input.workspace.wrapperPath)) {
    throw new Error("Authorized Android workspace paths are invalid");
  }
  if (!isAbsolute(input.stateDirectory) || input.stateDirectory.length > 4096) {
    throw new Error("Android build state directory is invalid");
  }
  if (input.signal?.aborted) throw new Error("Android build was cancelled");

  const discovery =
    input.workspace.kind === "flutter"
      ? await (async () => {
          if (!input.workspace.discoveryRoot || !input.workspace.candidateId) {
            throw new Error("Authorized Flutter discovery identity is unavailable");
          }
          const workspace = await discoverAndroidWorkspace(input.workspace.discoveryRoot, { platform });
          const candidate = workspace.candidates.find(item => item.candidateId === input.workspace.candidateId);
          if (!candidate || candidate.kind !== "flutter" || candidate.androidRoot !== input.workspace.canonicalRoot) {
            throw new Error("Authorized Flutter project changed before build execution");
          }
          return candidate;
        })()
      : await discoverAndroidProject(input.workspace.canonicalRoot, { platform });
  const module = discovery.modules.find(candidate => candidate.modulePath === input.workspace.modulePath);
  if (
    discovery.canonicalRoot !== input.workspace.canonicalRoot ||
    !discovery.wrapper ||
    discovery.wrapper.executablePath !== input.workspace.wrapperPath ||
    discovery.wrapper.fingerprint !== input.workspace.wrapperFingerprint ||
    !module?.variants.includes(input.workspace.variant)
  ) {
    throw new Error("Authorized Android workspace changed before build execution");
  }

  await mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
  const stateDirectory = await realpath(input.stateDirectory);
  const state = await lstat(stateDirectory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Android build state directory is unsafe");
  const env = sanitizedGradleEnvironment(options.env ?? process.env, stateDirectory);
  const task = taskFor(input.workspace.modulePath, input.workspace.variant);
  const command = androidGradleInvocation(platform, input.workspace.wrapperPath, task, env, input.forceRerun);
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminate = options.terminateProcess ?? terminateProcessTree;
  if (input.signal?.aborted) throw new Error("Android build was cancelled");
  const child = spawnProcess(command.executable, command.args, {
    cwd: input.workspace.canonicalRoot,
    env,
    shell: false,
    windowsHide: true,
    detached: platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let outputBytes = 0;
  let truncated = false;
  const append = (value: Buffer | string) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = Math.max(0, maxOutputBytes - outputBytes);
    const accepted = bytes.subarray(0, remaining);
    outputBytes += accepted.byteLength;
    if (accepted.byteLength) {
      const chunk = safeBuildOutput(accepted.toString("utf8"));
      output += chunk;
      input.onOutput?.(chunk, truncated || accepted.byteLength < bytes.byteLength);
    }
    if (accepted.byteLength < bytes.byteLength && !truncated) {
      truncated = true;
      if (!accepted.byteLength) input.onOutput?.("", true);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let stopReason: "cancelled" | "timeout" | undefined;
  let stopResolve!: () => void;
  const stopRequested = new Promise<void>(resolveStop => {
    stopResolve = resolveStop;
  });
  let termination: Promise<void> | undefined;
  const requestStop = (reason: "cancelled" | "timeout") => {
    if (stopReason) return;
    stopReason = reason;
    termination = Promise.resolve().then(() => terminate(child, "Android Gradle"));
    stopResolve();
  };
  const cancelled = () => requestStop("cancelled");
  input.signal?.addEventListener("abort", cancelled, { once: true });
  if (input.signal?.aborted) requestStop("cancelled");
  const timer = setTimeout(() => requestStop("timeout"), timeoutMs);
  timer.unref?.();

  const closed = new Promise<number>((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", code => resolveClose(code ?? -1));
  });
  try {
    const code = await Promise.race([
      closed,
      stopRequested.then(async () => {
        await termination;
        return child.exitCode ?? -1;
      }),
    ]);
    if (termination) await termination;
    return {
      task,
      code,
      succeeded: code === 0 && !stopReason,
      cancelled: stopReason === "cancelled",
      timedOut: stopReason === "timeout",
      output,
      truncated,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancelled);
    child.stdout?.off("data", append);
    child.stderr?.off("data", append);
  }
}
