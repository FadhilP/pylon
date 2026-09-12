import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AndroidRunner, type AndroidRunnerEvent, type AndroidRunnerSnapshot } from "pylon-android/android-runner";
import {
  discoverAndroidWorkspace,
  type AndroidProjectCandidate,
  type AndroidWorkspaceDiscovery,
} from "pylon-android/project-discovery";
import type { ApkDiscoveryInput } from "pylon-android/apk-artifact";
import {
  runAndroidGradleBuild,
  type AndroidGradleBuildInput,
  type AndroidGradleBuildResult,
} from "pylon-android/gradle-runner";
import {
  ANDROID_PROTOCOL_VERSION,
  type AndroidArtifactReadModel,
  type AndroidBuildReadModel,
  type AndroidCommand,
  type AndroidCommandResult,
  type AndroidProjectReadModel,
  type AndroidRunReadModel,
  type AndroidServiceEvent,
  type AndroidServiceSnapshot,
} from "../../shared/protocol/android.ts";
import { AndroidEventJournal } from "./android-event-journal.ts";
import { AndroidSettingsConflict, AndroidSettingsStore, type StoredAndroidProject } from "./android-settings-store.ts";
import {
  resolveAndroidWorkspace,
  type AndroidWorkspaceProvider,
  type ResolvedAndroidWorkspace,
} from "./workspace-resolver.ts";

const MAX_COMMANDS = 256;
const HOST_BUILD_OUTPUT_BYTES = 192 * 1024;
const HOST_LOG_OUTPUT_BYTES = 384 * 1024;
const DEFAULT_BUILD_CLEANUP_TIMEOUT_MS = 15_000;
const MAX_BUILD_CLEANUP_TIMEOUT_MS = 30_000;

type RunnerPort = Pick<
  AndroidRunner,
  "snapshot" | "subscribe" | "refresh" | "startEmulator" | "cancelOperation" | "stopEmulator" | "dispose"
>;

type SettingsPort = Pick<AndroidSettingsStore, "read" | "saveConfiguration" | "setTrust" | "close">;
type DiscoverProject = typeof discoverAndroidWorkspace;
type RunBuild = (input: AndroidGradleBuildInput) => Promise<AndroidGradleBuildResult>;

export type AndroidHostRunPhase =
  | "building"
  | "finding-artifact"
  | "staging"
  | "inspecting"
  | "installing"
  | "launching"
  | "complete"
  | "install-uncertain";

export interface AndroidHostBuildAndRunInput {
  build: AndroidGradleBuildInput;
  artifact?: ApkDiscoveryInput;
  stagingRoot: string;
  serial: string;
  expectedPackage?: string;
  revalidate(): Promise<void>;
  onPhase(phase: AndroidHostRunPhase): void;
}

export interface AndroidHostBuildAndRunResult {
  artifact: AndroidArtifactReadModel;
  installed: boolean;
  replacementInstall: boolean;
  installationIdentity: string;
}

export interface AndroidHostLogcat {
  snapshot(): { output: string; truncated: boolean; state?: "running" | "stopped" | "unavailable"; issue?: string };
  subscribe(listener: () => void): () => void;
  stop(): Promise<void>;
  clear(): void;
}

export interface AndroidHostAppRuntime {
  buildAndRun(input: AndroidHostBuildAndRunInput): Promise<AndroidHostBuildAndRunResult>;
  forceStop(serial: string, packageName: string, signal?: AbortSignal): Promise<void>;
  relaunch(serial: string, component: string, signal?: AbortSignal): Promise<void>;
  validateInstallation(serial: string, packageName: string, identity: string, signal?: AbortSignal): Promise<void>;
  startLogs(serial: string, packageName: string, signal?: AbortSignal): Promise<AndroidHostLogcat>;
}

export interface PylonAndroidHostOptions {
  settingsStore?: SettingsPort;
  settingsPath?: string;
  workspaceProvider?: AndroidWorkspaceProvider;
  workspaceValidator?: (workspace: ResolvedAndroidWorkspace) => void | Promise<void>;
  buildStateDirectory?: string;
  discoverProject?: DiscoverProject;
  runBuild?: RunBuild;
  stagingStateDirectory?: string;
  appRuntime?: AndroidHostAppRuntime;
  buildCleanupTimeoutMs?: number;
}

interface CommandEntry {
  fingerprint: string;
  promise: Promise<AndroidCommandResult>;
  settled: boolean;
}

interface ProjectState {
  read: AndroidProjectReadModel;
  workspace: ResolvedAndroidWorkspace;
  discovery: AndroidWorkspaceDiscovery;
  stored: StoredAndroidProject;
}

interface ActiveBuild {
  record: AndroidBuildReadModel;
  controller: AbortController;
  promise: Promise<void>;
  publishTimer?: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  record: AndroidRunReadModel;
  controller: AbortController;
  promise: Promise<void>;
  installationIdentity?: string;
  logcat?: AndroidHostLogcat;
  unsubscribeLogcat?: () => void;
}

export class AndroidHostError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Android operation failed";
  return (
    message
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 500) || "Android operation failed"
  );
}

function appendUtf8Tail(current: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(current + chunk);
  if (bytes.length <= maxBytes) return { value: current + chunk, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { value: bytes.subarray(start).toString("utf8"), truncated: true };
}

function fingerprint(command: AndroidCommand): string {
  const { commandId: _commandId, ...value } = command;
  return JSON.stringify(value);
}

function selectedCandidate(
  discovery: AndroidWorkspaceDiscovery,
  stored: StoredAndroidProject,
): AndroidProjectCandidate | undefined {
  const candidateId = stored.configuration?.candidateId;
  return candidateId ? discovery.candidates.find(candidate => candidate.candidateId === candidateId) : undefined;
}

function flutterArtifact(candidate: AndroidProjectCandidate, variant: string): ApkDiscoveryInput {
  if (candidate.kind !== "flutter" || !candidate.artifactOutputRoot || variant !== "debug") {
    throw new Error("Flutter artifact layout is unsupported");
  }
  return {
    workspaceRoot: candidate.candidateRoot,
    modulePath: ":app",
    variant: "debug",
    outputRoot: candidate.artifactOutputRoot,
    expectedOutputFile: "app-debug.apk",
  };
}
function sameTrust(state: Pick<ProjectState, "workspace" | "discovery" | "stored">): boolean {
  const trust = state.stored.trust;
  const candidate = selectedCandidate(state.discovery, state.stored);
  const wrapper = candidate?.wrapper;
  const configuration = state.stored.configuration;
  return !!(
    trust?.trusted &&
    wrapper &&
    configuration &&
    trust.configRevision === configuration.revision &&
    candidate?.modules.some(
      module => module.modulePath === configuration.modulePath && module.variants.includes(configuration.variant),
    ) &&
    trust.registeredRoot === state.workspace.canonicalRegisteredRoot &&
    trust.workspaceRoot === state.workspace.canonicalRoot &&
    trust.wrapperRelativePath === wrapper.executableRelativePath &&
    trust.wrapperFingerprint === wrapper.fingerprint
  );
}

export class PylonAndroidHost {
  private readonly stagingStateDirectory?: string;
  private readonly appRuntime?: AndroidHostAppRuntime;
  private readonly journal = new AndroidEventJournal(randomUUID());
  private readonly listeners = new Set<(event: AndroidServiceEvent) => void>();
  private readonly commands = new Map<string, CommandEntry>();
  private readonly unsubscribeRunner: () => void;
  private readonly settings?: SettingsPort;
  private readonly workspaceProvider?: AndroidWorkspaceProvider;
  private readonly workspaceValidator?: (workspace: ResolvedAndroidWorkspace) => void | Promise<void>;
  private run?: ActiveRun;
  private readonly buildStateDirectory?: string;
  private readonly discoverProject: DiscoverProject;
  private readonly runBuild: RunBuild;
  private readonly buildCleanupTimeoutMs: number;
  private refreshPromise?: Promise<AndroidRunnerSnapshot>;
  private disposePromise?: Promise<void>;
  private project?: ProjectState;
  private build?: ActiveBuild;
  private serviceRevision = 0;
  private lastError?: string;
  private accepting = true;
  private commandActive = false;
  private disposed = false;

  constructor(
    private readonly runner: RunnerPort = new AndroidRunner(),
    options: PylonAndroidHostOptions = {},
  ) {
    this.settings =
      options.settingsStore ?? (options.settingsPath ? new AndroidSettingsStore(options.settingsPath) : undefined);
    this.workspaceProvider = options.workspaceProvider;
    this.workspaceValidator = options.workspaceValidator;
    this.buildStateDirectory = options.buildStateDirectory;
    this.stagingStateDirectory = options.stagingStateDirectory;
    this.appRuntime = options.appRuntime;
    this.discoverProject = options.discoverProject ?? discoverAndroidWorkspace;
    this.runBuild = options.runBuild ?? (input => runAndroidGradleBuild(input));
    this.buildCleanupTimeoutMs = options.buildCleanupTimeoutMs ?? DEFAULT_BUILD_CLEANUP_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.buildCleanupTimeoutMs) ||
      this.buildCleanupTimeoutMs < 1 ||
      this.buildCleanupTimeoutMs > MAX_BUILD_CLEANUP_TIMEOUT_MS
    ) {
      throw new Error(`Android build cleanup timeout must be between 1 and ${MAX_BUILD_CLEANUP_TIMEOUT_MS}ms`);
    }
    this.unsubscribeRunner = runner.subscribe(event => this.onRunnerEvent(event));
  }

  async snapshot(refreshIfIdle = true): Promise<AndroidServiceSnapshot> {
    if (refreshIfIdle && this.accepting && this.runner.snapshot().discovery === "idle") {
      this.refreshPromise ??= this.runner.refresh().finally(() => {
        this.refreshPromise = undefined;
      });
      await this.refreshPromise;
    }
    return this.currentSnapshot();
  }

  subscribe(listener: (event: AndroidServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replay(cursor: string | undefined) {
    return this.journal.replay(cursor);
  }

  cursor(sequence?: number): string {
    return this.journal.cursor(sequence);
  }

  command(command: AndroidCommand): Promise<AndroidCommandResult> {
    if (!this.accepting) throw new AndroidHostError(503, "Android Runner is shutting down");
    const prior = this.commands.get(command.commandId);
    const commandFingerprint = fingerprint(command);
    if (prior) {
      if (prior.fingerprint !== commandFingerprint) {
        throw new AndroidHostError(409, "Android command ID was reused with different input");
      }
      return prior.promise;
    }
    const identityRevisioned = [
      "cancelOperation",
      "cancelBuild",
      "stopApp",
      "relaunchApp",
      "startLogs",
      "stopLogs",
      "clearRetainedOutput",
    ].includes(command.type);
    if (!identityRevisioned && command.expectedServiceRevision !== this.serviceRevision) {
      throw new AndroidHostError(409, "Android service revision is stale");
    }
    const exclusive = command.type !== "cancelOperation" && command.type !== "cancelBuild";
    if (exclusive && this.commandActive) throw new AndroidHostError(409, "Another Android command is active");
    this.makeCommandRoom();
    if (exclusive) this.commandActive = true;
    const entry: CommandEntry = {
      fingerprint: commandFingerprint,
      settled: false,
      promise: Promise.resolve()
        .then(() => this.execute(command))
        .finally(() => {
          entry.settled = true;
          if (exclusive) this.commandActive = false;
        }),
    };
    this.commands.set(command.commandId, entry);
    void entry.promise.catch(() => undefined);
    return entry.promise;
  }

  quiesce(): void {
    this.accepting = false;
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    this.quiesce();
    this.build?.controller.abort();
    this.run?.controller.abort();
    const activeCommands = [...this.commands.values()]
      .filter(entry => !entry.settled)
      .map(entry =>
        this.awaitBuildCleanup(
          entry.promise.then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
    const runnerCleanup = this.runner.dispose();
    this.disposePromise = (async () => {
      const cleanup = await Promise.allSettled([
        runnerCleanup,
        ...(this.run ? [this.stopRunLogcat(this.run), this.awaitBuildCleanup(this.run.promise)] : []),
        ...(this.build && this.build.promise !== this.run?.promise ? [this.awaitBuildCleanup(this.build.promise)] : []),
        ...activeCommands,
      ]);
      const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
      try {
        this.settings?.close();
      } catch (error) {
        failures.push(error);
      }
      this.disposed = true;
      this.unsubscribeRunner();
      this.listeners.clear();
      if (failures.length) throw new AggregateError(failures, "Android host cleanup failed");
    })().finally(() => {
      this.disposePromise = undefined;
    });
    return this.disposePromise;
  }

  private async execute(command: AndroidCommand): Promise<AndroidCommandResult> {
    this.lastError = undefined;
    try {
      switch (command.type) {
        case "refresh":
          await this.runner.refresh();
          break;
        case "startEmulator": {
          const snapshot = this.runner.snapshot();
          if (snapshot.discovery !== "ready" || !snapshot.avds.includes(command.avd)) {
            throw new AndroidHostError(409, "Android AVD selection is stale or unavailable");
          }
          void this.runner.startEmulator(command.avd).catch(error => this.publishError(error));
          break;
        }
        case "cancelOperation":
          this.runner.cancelOperation(command.deviceId, command.deviceRevision);
          break;
        case "stopEmulator": {
          const device = this.runner.snapshot().devices.find(item => item.deviceId === command.deviceId);
          if (!device || device.ownership !== "runner") {
            throw new AndroidHostError(409, "Only a runner-owned Android emulator can be stopped");
          }
          await this.cancelRunForDevice(command.deviceId);
          await this.runner.stopEmulator(command.deviceId, command.deviceRevision);
          break;
        }
        case "refreshProject":
          await this.refreshProject(command.expectedGeneration);
          break;
        case "saveRunConfiguration":
          await this.saveConfiguration(command);
          break;
        case "setWorkspaceTrust":
          await this.setTrust(command);
          break;
        case "build":
          await this.startBuild(command);
          break;
        case "buildAndRun":
          await this.startBuildAndRun(command);
          break;
        case "cancelBuild":
          this.cancelBuild(command.operationId, command.operationRevision);
          break;
        case "stopApp":
          await this.stopApp(command.runId, command.runRevision);
          break;
        case "relaunchApp":
          await this.relaunchApp(command.runId, command.runRevision);
          break;
        case "startLogs":
          await this.startLogs(command.runId, command.runRevision);
          break;
        case "stopLogs":
          await this.stopLogs(command.runId, command.runRevision);
          break;
        case "clearRetainedOutput":
          this.clearRetainedOutput(command.runId, command.runRevision);
          break;
      }
      return { commandId: command.commandId, snapshot: this.currentSnapshot() };
    } catch (error) {
      if (error instanceof AndroidHostError) throw error;
      if (
        error instanceof AndroidSettingsConflict ||
        (error instanceof Error && /revision is stale/.test(error.message))
      ) {
        throw new AndroidHostError(409, boundedError(error));
      }
      this.publishError(error);
      throw new AndroidHostError(400, boundedError(error));
    }
  }

  private async refreshProject(expectedGeneration: number): Promise<ProjectState> {
    if (!this.settings || !this.workspaceProvider)
      throw new AndroidHostError(409, "Android project support is unavailable");
    const workspace = await resolveAndroidWorkspace(this.workspaceProvider, expectedGeneration);
    const discovery = await this.discoverProject(workspace.canonicalRoot);
    if (discovery.canonicalRoot !== workspace.canonicalRoot) throw new Error("Android workspace identity changed");
    const stored = this.settings.read(workspace.projectId);
    const configured = stored.configuration;
    const candidate = selectedCandidate(discovery, stored);
    const configurationValid = !!(
      configured &&
      candidate?.modules.some(
        module => module.modulePath === configured.modulePath && module.variants.includes(configured.variant),
      )
    );
    const soleCandidate = discovery.candidates.length === 1 ? discovery.candidates[0] : undefined;
    const displayedCandidate = candidate ?? soleCandidate;
    const trustStatus = !stored.trust?.trusted
      ? "untrusted"
      : sameTrust({ workspace, discovery, stored })
        ? "trusted"
        : "stale";
    const read: AndroidProjectReadModel = {
      projectId: workspace.projectId,
      sessionId: workspace.sessionId,
      sessionGeneration: workspace.sessionGeneration,
      workspaceKind: workspace.workspaceKind,
      workspaceLabel: workspace.workspaceLabel,
      discovery: discovery.candidates.some(item => item.wrapper && item.modules.length) ? "ready" : "unsupported",
      candidates: discovery.candidates.map(item => ({
        candidateId: item.candidateId,
        kind: item.kind,
        label: item.label,
        discovery: item.wrapper && item.modules.length ? "ready" : "unsupported",
        modules: item.modules.map(module => ({ modulePath: module.modulePath, variants: [...module.variants] })),
        ...(item.issue ? { issue: item.issue } : {}),
      })),
      modules:
        displayedCandidate?.modules.map(module => ({
          modulePath: module.modulePath,
          variants: [...module.variants],
        })) ?? [],
      ...(configured ? { configuration: { ...configured } } : {}),
      trust: {
        status: trustStatus,
        revision: stored.trustRevision,
        ...(stored.trust?.trusted ? { trustedAt: stored.trust.updatedAt } : {}),
      },
      ...(discovery.issue
        ? { issue: discovery.issue }
        : configured && !configurationValid
          ? { issue: "Saved Android project, module, or variant is not available in this workspace" }
          : {}),
    };
    this.project = { read, workspace, discovery, stored };
    this.changed();
    return this.project;
  }

  private async saveConfiguration(command: Extract<AndroidCommand, { type: "saveRunConfiguration" }>): Promise<void> {
    const state = await this.refreshProject(command.expectedGeneration);
    const candidate = state.discovery.candidates.find(item => item.candidateId === command.candidateId);
    const suggestion = candidate?.modules.find(module => module.modulePath === command.modulePath);
    if (!suggestion?.variants.includes(command.variant)) {
      throw new AndroidHostError(409, "Android module or variant is stale or unsupported");
    }
    this.cancelBuildForProject(state.workspace.projectId);
    this.cancelRunForProject(state.workspace.projectId);
    this.settings!.saveConfiguration(
      state.workspace.projectId,
      command.expectedConfigRevision,
      command.modulePath,
      command.variant,
      command.candidateId,
    );
    await this.refreshProject(command.expectedGeneration);
  }

  private async setTrust(command: Extract<AndroidCommand, { type: "setWorkspaceTrust" }>): Promise<void> {
    const state = await this.refreshProject(command.expectedGeneration);
    const configuration = state.stored.configuration;
    if (!configuration || configuration.revision !== command.expectedConfigRevision) {
      throw new AndroidHostError(409, "Android configuration is stale or unavailable");
    }
    if (state.stored.trustRevision !== command.expectedTrustRevision) {
      throw new AndroidHostError(409, "Android trust revision is stale");
    }
    if (!command.trusted) {
      const prior = state.stored.trust;
      if (!prior?.trusted) throw new AndroidHostError(409, "Android workspace is already untrusted");
      this.cancelBuildForProject(state.workspace.projectId);
      this.cancelRunForProject(state.workspace.projectId);
      this.settings!.setTrust(state.workspace.projectId, command.expectedTrustRevision, {
        trusted: false,
        configRevision: configuration.revision,
        registeredRoot: prior.registeredRoot,
        workspaceRoot: prior.workspaceRoot,
        wrapperRelativePath: prior.wrapperRelativePath,
        wrapperFingerprint: prior.wrapperFingerprint,
      });
      await this.refreshProject(command.expectedGeneration);
      return;
    }
    const candidate = selectedCandidate(state.discovery, state.stored);
    const wrapper = candidate?.wrapper;
    if (!wrapper) throw new AndroidHostError(409, "A complete Gradle wrapper is unavailable");
    if (
      !candidate.modules.some(
        module => module.modulePath === configuration.modulePath && module.variants.includes(configuration.variant),
      )
    ) {
      throw new AndroidHostError(409, "Android configuration is unavailable in this workspace");
    }
    this.settings!.setTrust(state.workspace.projectId, command.expectedTrustRevision, {
      trusted: true,
      configRevision: configuration.revision,
      registeredRoot: state.workspace.canonicalRegisteredRoot,
      workspaceRoot: state.workspace.canonicalRoot,
      wrapperRelativePath: wrapper.executableRelativePath,
      wrapperFingerprint: wrapper.fingerprint,
    });
    await this.refreshProject(command.expectedGeneration);
  }

  private async startBuild(command: Extract<AndroidCommand, { type: "build" }>): Promise<void> {
    if (this.build && ["queued", "running", "cancelling"].includes(this.build.record.state)) {
      throw new AndroidHostError(409, "An Android build is already active");
    }
    if (!this.buildStateDirectory) throw new AndroidHostError(409, "Android build support is unavailable");
    const state = await this.refreshProject(command.expectedGeneration);
    if (!this.accepting || this.disposed) throw new AndroidHostError(503, "Android Runner is shutting down");
    const configuration = state.stored.configuration;
    if (!configuration || configuration.revision !== command.configRevision) {
      throw new AndroidHostError(409, "Android configuration is stale or unavailable");
    }
    const candidate = selectedCandidate(state.discovery, state.stored);
    if (
      !candidate?.modules.some(
        module => module.modulePath === configuration.modulePath && module.variants.includes(configuration.variant),
      )
    ) {
      throw new AndroidHostError(409, "Android configuration is unavailable in this workspace");
    }
    if (state.stored.trustRevision !== command.trustRevision || !sameTrust(state)) {
      throw new AndroidHostError(409, "Android workspace is not trusted for this build");
    }
    const wrapper = candidate.wrapper!;
    const controller = new AbortController();
    const record: AndroidBuildReadModel = {
      operationId: randomUUID(),
      revision: 1,
      projectId: state.workspace.projectId,
      sessionId: state.workspace.sessionId,
      sessionGeneration: state.workspace.sessionGeneration,
      workspaceLabel: state.workspace.workspaceLabel,
      modulePath: configuration.modulePath,
      variant: configuration.variant,
      state: "queued",
      startedAt: new Date().toISOString(),
      output: "",
      outputTruncated: false,
    };
    const active = { record, controller, promise: Promise.resolve() } as ActiveBuild;
    this.build = active;
    this.changedBuild(active, "running");
    const buildInput: AndroidGradleBuildInput = {
      workspace: {
        canonicalRoot: candidate.androidRoot,
        wrapperPath: wrapper.executablePath,
        wrapperFingerprint: wrapper.fingerprint,
        modulePath: configuration.modulePath,
        kind: candidate.kind,
        ...(candidate.kind === "flutter"
          ? { discoveryRoot: state.workspace.canonicalRoot, candidateId: candidate.candidateId }
          : {}),
        variant: configuration.variant,
      },
      stateDirectory: resolve(
        this.buildStateDirectory,
        createHash("sha256").update(state.workspace.projectId).digest("hex"),
      ),
      signal: controller.signal,
      forceRerun: candidate.kind === "flutter",
      maxOutputBytes: HOST_BUILD_OUTPUT_BYTES,
      onOutput: (chunk, truncated) => {
        if (this.disposed || this.build !== active) return;
        const output = appendUtf8Tail(active.record.output, chunk, HOST_BUILD_OUTPUT_BYTES);
        active.record.output = output.value;
        active.record.outputTruncated ||= truncated || output.truncated;
        this.queueBuildOutput(active);
      },
    };
    active.promise = this.runBuild(buildInput)
      .then(result => {
        if (this.disposed || this.build !== active) return;
        active.record.outputTruncated ||= result.truncated;
        this.changedBuild(
          active,
          result.cancelled ? "cancelled" : result.timedOut ? "timed-out" : result.succeeded ? "succeeded" : "failed",
          result.succeeded
            ? undefined
            : result.timedOut
              ? "Android build timed out"
              : result.cancelled
                ? undefined
                : `Gradle exited with code ${result.code}`,
        );
      })
      .catch(error => {
        if (!this.disposed && this.build === active)
          this.changedBuild(active, controller.signal.aborted ? "cancelled" : "failed", boundedError(error));
      });
  }

  private async startBuildAndRun(command: Extract<AndroidCommand, { type: "buildAndRun" }>): Promise<void> {
    if (this.build && ["queued", "running", "cancelling"].includes(this.build.record.state)) {
      throw new AndroidHostError(409, "An Android build is already active");
    }
    if (this.run?.record.phase === "running") {
      throw new AndroidHostError(409, "Stop the current Android app before starting another run");
    }
    if (!this.buildStateDirectory || !this.stagingStateDirectory || !this.appRuntime) {
      throw new AndroidHostError(409, "Android Build & Run support is unavailable");
    }
    const state = await this.refreshProject(command.expectedGeneration);
    await this.runner.refresh();
    if (!this.accepting || this.disposed) throw new AndroidHostError(503, "Android Runner is shutting down");
    const configuration = state.stored.configuration;
    if (!configuration || configuration.revision !== command.configRevision) {
      throw new AndroidHostError(409, "Android configuration is stale or unavailable");
    }
    if (state.stored.trustRevision !== command.trustRevision || !sameTrust(state)) {
      throw new AndroidHostError(409, "Android workspace is not trusted for this run");
    }
    const candidate = selectedCandidate(state.discovery, state.stored);
    if (!candidate?.wrapper) throw new AndroidHostError(409, "Android project candidate is unavailable");
    const device = this.runner.snapshot().devices.find(item => item.deviceId === command.deviceId);
    if (!device?.serial || device.state !== "ready" || device.revision !== command.deviceRevision) {
      throw new AndroidHostError(409, "Android deployment device is stale or unavailable");
    }
    if (this.run) await this.stopRunLogcat(this.run);
    const operationId = randomUUID();
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const buildRecord: AndroidBuildReadModel = {
      operationId,
      revision: 1,
      projectId: state.workspace.projectId,
      sessionId: state.workspace.sessionId,
      sessionGeneration: state.workspace.sessionGeneration,
      workspaceLabel: state.workspace.workspaceLabel,
      modulePath: configuration.modulePath,
      variant: configuration.variant,
      state: "running",
      startedAt,
      output: "",
      outputTruncated: false,
    };
    const runRecord: AndroidRunReadModel = {
      runId: randomUUID(),
      operationId,
      revision: 1,
      projectId: state.workspace.projectId,
      sessionId: state.workspace.sessionId,
      sessionGeneration: state.workspace.sessionGeneration,
      workspaceLabel: state.workspace.workspaceLabel,
      modulePath: configuration.modulePath,
      variant: configuration.variant,
      deviceId: device.deviceId,
      deviceRevision: device.revision,
      serial: device.serial,
      avd: device.avd,
      ownership: device.ownership,
      phase: "building",
      startedAt,
      logs: { revision: 0, state: "idle", output: "", outputTruncated: false },
    };
    const activeBuild = { record: buildRecord, controller, promise: Promise.resolve() } as ActiveBuild;
    const activeRun = { record: runRecord, controller, promise: Promise.resolve() } as ActiveRun;
    this.build = activeBuild;
    this.run = activeRun;
    this.changed();
    const wrapper = candidate.wrapper;
    const build: AndroidGradleBuildInput = {
      workspace: {
        canonicalRoot: candidate.androidRoot,
        wrapperPath: wrapper.executablePath,
        kind: candidate.kind,
        ...(candidate.kind === "flutter"
          ? { discoveryRoot: state.workspace.canonicalRoot, candidateId: candidate.candidateId }
          : {}),
        wrapperFingerprint: wrapper.fingerprint,
        modulePath: configuration.modulePath,
        variant: configuration.variant,
      },
      stateDirectory: resolve(
        this.buildStateDirectory,
        createHash("sha256").update(state.workspace.projectId).digest("hex"),
      ),
      signal: controller.signal,
      forceRerun: candidate.kind === "flutter",
      maxOutputBytes: HOST_BUILD_OUTPUT_BYTES,
      onOutput: (chunk, truncated) => {
        if (this.disposed || this.build !== activeBuild) return;
        const output = appendUtf8Tail(activeBuild.record.output, chunk, HOST_BUILD_OUTPUT_BYTES);
        activeBuild.record.output = output.value;
        activeBuild.record.outputTruncated ||= truncated || output.truncated;
        this.queueBuildOutput(activeBuild);
      },
    };
    const operation = this.appRuntime
      .buildAndRun({
        build,
        ...(candidate.kind === "flutter" ? { artifact: flutterArtifact(candidate, configuration.variant) } : {}),
        stagingRoot: resolve(
          this.stagingStateDirectory,
          createHash("sha256").update(state.workspace.projectId).digest("hex"),
        ),
        serial: device.serial,
        revalidate: () =>
          this.revalidateRun(state, configuration.revision, command.trustRevision, device, controller.signal),
        onPhase: phase => this.onRunPhase(activeRun, activeBuild, phase),
      })
      .then(result => {
        if (this.disposed || this.run !== activeRun) return;
        activeRun.controller = new AbortController();
        activeRun.record.artifact = result.artifact;
        activeRun.record.installed = result.installed;
        activeRun.record.replacementInstall = result.replacementInstall;
        activeRun.installationIdentity = result.installationIdentity;
        this.changedRun(activeRun, "running");
        if (["queued", "running", "cancelling"].includes(activeBuild.record.state)) {
          this.changedBuild(activeBuild, "succeeded");
        }
      })
      .catch(error => {
        if (this.disposed || this.run !== activeRun) return;
        activeRun.controller = new AbortController();
        const details = error as {
          installed?: boolean;
          installUncertain?: boolean;
          artifact?: AndroidArtifactReadModel;
          installationIdentity?: string;
        };
        if (details.artifact) activeRun.record.artifact = details.artifact;
        if (details.installed) activeRun.record.installed = true;
        if (details.installUncertain) activeRun.record.installUncertain = true;
        if (details.installationIdentity) activeRun.installationIdentity = details.installationIdentity;
        const cancelled = controller.signal.aborted && !details.installUncertain;
        this.changedRun(activeRun, cancelled ? "cancelled" : "failed", boundedError(error));
        if (["queued", "running", "cancelling"].includes(activeBuild.record.state)) {
          this.changedBuild(activeBuild, cancelled ? "cancelled" : "failed", boundedError(error));
        }
      });
    activeBuild.promise = operation;
    activeRun.promise = operation;
  }

  private async revalidateRun(
    captured: ProjectState,
    configRevision: number,
    trustRevision: number,
    device: AndroidRunnerSnapshot["devices"][number],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || !this.accepting) throw new Error("Android run was cancelled");
    await this.workspaceValidator?.(captured.workspace);
    const discovery = await this.discoverProject(captured.workspace.canonicalRoot);
    const stored = this.settings!.read(captured.workspace.projectId);
    const current = { workspace: captured.workspace, discovery, stored };
    const capturedCandidate = selectedCandidate(captured.discovery, captured.stored);
    const currentCandidate = selectedCandidate(discovery, stored);
    if (
      discovery.canonicalRoot !== captured.workspace.canonicalRoot ||
      !capturedCandidate ||
      !currentCandidate ||
      currentCandidate.candidateRoot !== capturedCandidate.candidateRoot ||
      currentCandidate.androidRoot !== capturedCandidate.androidRoot ||
      stored.configRevision !== configRevision ||
      stored.trustRevision !== trustRevision ||
      !sameTrust(current)
    ) {
      throw new Error("Android workspace authorization changed before deployment");
    }
    await this.runner.refresh(signal);
    const currentDevice = this.runner.snapshot().devices.find(item => item.deviceId === device.deviceId);
    if (
      !currentDevice ||
      currentDevice.state !== "ready" ||
      currentDevice.serial !== device.serial ||
      currentDevice.avd !== device.avd ||
      currentDevice.ownership !== device.ownership ||
      currentDevice.revision !== device.revision
    ) {
      throw new Error("Android deployment device identity changed");
    }
    if (signal.aborted || !this.accepting) throw new Error("Android run was cancelled");
  }

  private onRunPhase(activeRun: ActiveRun, activeBuild: ActiveBuild, phase: AndroidHostRunPhase): void {
    if (this.disposed || this.run !== activeRun) return;
    if (["finding-artifact", "staging", "inspecting"].includes(phase)) {
      if (["queued", "running", "cancelling"].includes(activeBuild.record.state)) {
        this.changedBuild(activeBuild, "succeeded");
      }
      this.changedRun(activeRun, "inspecting");
    } else if (phase === "installing" || phase === "install-uncertain") {
      if (phase === "install-uncertain") activeRun.record.installUncertain = true;
      this.changedRun(activeRun, "installing");
    } else if (phase === "launching") {
      this.changedRun(activeRun, "launching");
    }
  }

  private async stopApp(runId: string, expectedRevision: number): Promise<void> {
    const active = this.requireRun(runId, expectedRevision);
    if (!active.record.artifact || !active.record.installed)
      throw new AndroidHostError(409, "Android app is unavailable");
    await this.revalidateRunDevice(active);
    await this.validateRunInstallation(active);
    await this.stopRunLogcat(active);
    await this.appRuntime!.forceStop(
      active.record.serial,
      active.record.artifact.packageName,
      active.controller.signal,
    );
    this.changedRun(active, "stopped");
  }

  private async relaunchApp(runId: string, expectedRevision: number): Promise<void> {
    const active = this.requireRun(runId, expectedRevision);
    if (!active.record.artifact || !active.record.installed)
      throw new AndroidHostError(409, "Android app is unavailable");
    await this.revalidateRunDevice(active);
    await this.validateRunInstallation(active);
    this.changedRun(active, "launching");
    try {
      await this.appRuntime!.relaunch(
        active.record.serial,
        active.record.artifact.launcherComponent,
        active.controller.signal,
      );
      this.changedRun(active, "running");
    } catch (error) {
      this.changedRun(active, "failed", boundedError(error));
      throw error;
    }
  }

  private async startLogs(runId: string, expectedRevision: number): Promise<void> {
    const active = this.requireRun(runId, expectedRevision);
    if (active.record.phase !== "running" || !active.record.artifact) {
      throw new AndroidHostError(409, "Android app is not running");
    }
    await this.revalidateRunDevice(active);
    await this.validateRunInstallation(active);
    await this.stopRunLogcat(active);
    active.record.logs.state = "starting";
    active.record.logs.revision++;
    this.changedRun(active, active.record.phase);
    try {
      const logcat = await this.appRuntime!.startLogs(
        active.record.serial,
        active.record.artifact.packageName,
        active.controller.signal,
      );
      active.logcat = logcat;
      active.unsubscribeLogcat = logcat.subscribe(() => this.onLogcat(active));
      active.record.logs.state = "running";
      this.onLogcat(active);
    } catch (error) {
      active.record.logs.state = "unavailable";
      active.record.logs.issue = boundedError(error);
      active.record.logs.revision++;
      this.changedRun(active, active.record.phase);
      throw error;
    }
  }

  private async stopLogs(runId: string, expectedRevision: number): Promise<void> {
    const active = this.requireRun(runId, expectedRevision);
    await this.stopRunLogcat(active);
    active.record.logs.state = "stopped";
    active.record.logs.revision++;
    this.changedRun(active, active.record.phase);
  }

  private clearRetainedOutput(runId: string, expectedRevision: number): void {
    const active = this.requireRun(runId, expectedRevision);
    active.logcat?.clear();
    active.record.logs.output = "";
    active.record.logs.outputTruncated = false;
    active.record.logs.issue = undefined;
    active.record.logs.revision++;
    this.changedRun(active, active.record.phase);
  }

  private onLogcat(active: ActiveRun): void {
    if (this.disposed || this.run !== active || !active.logcat) return;
    const log = active.logcat.snapshot();
    const output = appendUtf8Tail("", log.output, HOST_LOG_OUTPUT_BYTES);
    active.record.logs.output = output.value;
    active.record.logs.outputTruncated = log.truncated || output.truncated;
    if (log.state) active.record.logs.state = log.state;
    active.record.logs.issue = log.issue;
    active.record.logs.revision++;
    try {
      this.changed();
    } catch (error) {
      active.record.logs.state = "unavailable";
      active.record.logs.issue = boundedError(error);
      active.record.logs.output = "";
      active.record.logs.outputTruncated = true;
      active.record.logs.revision++;
      try {
        this.changed();
      } catch {}
      void this.stopRunLogcat(active).catch(() => undefined);
    }
  }

  private async stopRunLogcat(active: ActiveRun): Promise<void> {
    active.unsubscribeLogcat?.();
    active.unsubscribeLogcat = undefined;
    const logcat = active.logcat;
    active.logcat = undefined;
    if (logcat) await logcat.stop();
  }

  private async revalidateRunDevice(active: ActiveRun): Promise<void> {
    await this.runner.refresh(active.controller.signal);
    const device = this.runner.snapshot().devices.find(item => item.deviceId === active.record.deviceId);
    if (
      !device ||
      device.state !== "ready" ||
      device.serial !== active.record.serial ||
      device.avd !== active.record.avd ||
      device.ownership !== active.record.ownership
    ) {
      throw new AndroidHostError(409, "Android run device identity changed");
    }
  }

  private async validateRunInstallation(active: ActiveRun): Promise<void> {
    if (!active.record.artifact || !active.installationIdentity) {
      throw new AndroidHostError(409, "Android installation identity is unavailable");
    }
    await this.appRuntime!.validateInstallation(
      active.record.serial,
      active.record.artifact.packageName,
      active.installationIdentity,
      active.controller.signal,
    );
  }

  private requireRun(runId: string, expectedRevision: number): ActiveRun {
    const active = this.run;
    if (!active || active.record.runId !== runId) throw new AndroidHostError(409, "Android run is unavailable");
    if (active.record.revision !== expectedRevision) throw new AndroidHostError(409, "Android run revision is stale");
    if (!this.appRuntime) throw new AndroidHostError(409, "Android app support is unavailable");
    return active;
  }

  private changedRun(active: ActiveRun, phase: AndroidRunReadModel["phase"], issue?: string): void {
    active.record.phase = phase;
    active.record.revision++;
    if (["running", "stopped", "cancelled", "failed"].includes(phase)) {
      active.record.finishedAt = new Date().toISOString();
    } else {
      active.record.finishedAt = undefined;
    }
    if (issue) active.record.issue = issue;
    else if (phase === "running") active.record.issue = undefined;
    this.changed();
  }

  private cancelBuild(operationId: string, expectedRevision: number): void {
    const run = this.run;
    if (
      run?.record.operationId === operationId &&
      ["building", "inspecting", "installing", "launching"].includes(run.record.phase)
    ) {
      if (run.record.revision !== expectedRevision) throw new AndroidHostError(409, "Android run revision is stale");
      run.controller.abort();
      const build = this.build;
      if (build && ["queued", "running"].includes(build.record.state)) this.changedBuild(build, "cancelling");
      return;
    }
    const active = this.build;
    if (!active || active.record.operationId !== operationId) {
      throw new AndroidHostError(409, "Android build operation is unavailable");
    }
    if (active.record.revision !== expectedRevision) throw new AndroidHostError(409, "Android build revision is stale");
    if (!["queued", "running", "cancelling"].includes(active.record.state)) return;
    if (active.record.state !== "cancelling") this.changedBuild(active, "cancelling");
    active.controller.abort();
  }

  private cancelBuildForProject(projectId: string): void {
    const active = this.build;
    if (
      !active ||
      active.record.projectId !== projectId ||
      !["queued", "running", "cancelling"].includes(active.record.state)
    )
      return;
    if (active.record.state !== "cancelling") this.changedBuild(active, "cancelling");
    active.controller.abort();
  }

  private cancelRunForProject(projectId: string): void {
    const active = this.run;
    if (
      active?.record.projectId === projectId &&
      ["building", "inspecting", "installing", "launching"].includes(active.record.phase)
    ) {
      active.controller.abort();
    }
  }

  private async cancelRunForDevice(deviceId: string): Promise<void> {
    const active = this.run;
    if (!active || active.record.deviceId !== deviceId) return;
    if (["building", "inspecting", "installing", "launching"].includes(active.record.phase)) {
      active.controller.abort();
      await this.awaitBuildCleanup(active.promise);
    }
    await this.stopRunLogcat(active);
    if (active.record.phase === "running") this.changedRun(active, "stopped");
  }

  private queueBuildOutput(active: ActiveBuild): void {
    if (active.publishTimer) return;
    active.publishTimer = setTimeout(() => {
      active.publishTimer = undefined;
      if (!this.disposed && this.build === active) this.changed();
    }, 100);
    active.publishTimer.unref?.();
  }

  private changedBuild(active: ActiveBuild, state: AndroidBuildReadModel["state"], issue?: string): void {
    if (active.publishTimer) {
      clearTimeout(active.publishTimer);
      active.publishTimer = undefined;
    }
    active.record.state = state;
    active.record.revision++;
    if (["cancelled", "succeeded", "failed", "timed-out"].includes(state))
      active.record.finishedAt = new Date().toISOString();
    if (issue) active.record.issue = issue;
    this.changed();
  }

  private currentSnapshot(): AndroidServiceSnapshot {
    return {
      protocolVersion: ANDROID_PROTOCOL_VERSION,
      serviceEpoch: this.journal.epoch,
      sequence: this.journal.sequence,
      serviceRevision: this.serviceRevision,
      runner: this.runner.snapshot(),
      ...(this.project ? { project: structuredClone(this.project.read) } : {}),
      ...(this.build ? { build: structuredClone(this.build.record) } : {}),
      ...(this.run ? { run: structuredClone(this.run.record) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private onRunnerEvent(event: AndroidRunnerEvent): void {
    const active = this.run;
    if (active?.record.phase === "running") {
      const device = event.snapshot.devices.find(item => item.deviceId === active.record.deviceId);
      if (
        !device ||
        device.state !== "ready" ||
        device.serial !== active.record.serial ||
        device.avd !== active.record.avd
      ) {
        active.record.logs.state = "unavailable";
        active.record.logs.issue = "Android run device disconnected or changed identity";
        active.record.logs.revision++;
        void this.stopRunLogcat(active).catch(error => this.publishError(error));
        this.changedRun(active, "failed", "Android run device disconnected or changed identity");
        return;
      }
    }
    this.serviceRevision++;
    this.publish(event.snapshot);
  }

  private publishError(error: unknown): void {
    this.lastError = boundedError(error);
    this.serviceRevision++;
    this.publish(this.runner.snapshot());
  }

  private async awaitBuildCleanup(operation: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Android build cleanup did not finish within ${this.buildCleanupTimeoutMs}ms`)),
        this.buildCleanupTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([operation, expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private changed(): void {
    this.serviceRevision++;
    this.publish(this.runner.snapshot());
  }

  private publish(snapshot: AndroidRunnerSnapshot): void {
    const event = this.journal.append(this.serviceRevision, {
      runner: snapshot,
      ...(this.project ? { project: structuredClone(this.project.read) } : {}),
      ...(this.build ? { build: structuredClone(this.build.record) } : {}),
      ...(this.run ? { run: structuredClone(this.run.record) } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private makeCommandRoom(): void {
    if (this.commands.size < MAX_COMMANDS) return;
    for (const [id, entry] of this.commands) {
      if (!entry.settled) continue;
      this.commands.delete(id);
      return;
    }
    throw new AndroidHostError(429, "Too many Android commands are active");
  }
}
