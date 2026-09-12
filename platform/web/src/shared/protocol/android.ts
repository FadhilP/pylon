import type { AndroidRunnerDevice, AndroidRunnerSnapshot } from "pylon-android/android-runner";

export const ANDROID_PROTOCOL_VERSION = 4 as const;
export const ANDROID_EVENT_MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MODULE_PATH = /^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$/;
const VARIANT = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export interface AndroidRunConfigurationReadModel {
  candidateId: string;
  modulePath: string;
  variant: string;
  revision: number;
  updatedAt: string;
}

export interface AndroidProjectCandidateReadModel {
  candidateId: string;
  kind: "gradle" | "flutter";
  label: string;
  discovery: "ready" | "unsupported";
  modules: Array<{ modulePath: string; variants: string[] }>;
  issue?: string;
}

export interface AndroidProjectReadModel {
  projectId: string;
  sessionId: string;
  sessionGeneration: number;
  workspaceKind: "local" | "project-folder" | "session-worktree";
  workspaceLabel: string;
  discovery: "ready" | "unsupported" | "unavailable";
  modules: Array<{ modulePath: string; variants: string[] }>;
  candidates: AndroidProjectCandidateReadModel[];
  configuration?: AndroidRunConfigurationReadModel;
  trust: { status: "untrusted" | "trusted" | "stale"; revision: number; trustedAt?: string };
  issue?: string;
}

export interface AndroidBuildReadModel {
  operationId: string;
  revision: number;
  projectId: string;
  sessionId: string;
  sessionGeneration: number;
  workspaceLabel: string;
  modulePath: string;
  variant: string;
  state: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed" | "timed-out";
  startedAt: string;
  finishedAt?: string;
  output: string;
  outputTruncated: boolean;
  issue?: string;
}

export interface AndroidArtifactReadModel {
  sha256: string;
  bytes: number;
  packageName: string;
  versionCode: string;
  versionName?: string;
  minSdk?: string;
  targetSdk?: string;
  signingCertificateSha256: string;
  launcherComponent: string;
  debuggable: boolean;
}

export interface AndroidRunLogsReadModel {
  revision: number;
  state: "idle" | "starting" | "running" | "stopped" | "unavailable";
  output: string;
  outputTruncated: boolean;
  issue?: string;
}

export interface AndroidRunReadModel {
  runId: string;
  operationId: string;
  revision: number;
  projectId: string;
  sessionId: string;
  sessionGeneration: number;
  workspaceLabel: string;
  modulePath: string;
  variant: string;
  deviceId: string;
  deviceRevision: number;
  serial: string;
  avd: string;
  ownership: "runner" | "external";
  phase: "building" | "inspecting" | "installing" | "launching" | "running" | "stopped" | "cancelled" | "failed";
  startedAt: string;
  finishedAt?: string;
  artifact?: AndroidArtifactReadModel;
  installed?: boolean;
  installUncertain?: boolean;
  replacementInstall?: boolean;
  issue?: string;
  logs: AndroidRunLogsReadModel;
}

export interface AndroidServicePayload {
  runner: AndroidRunnerSnapshot;
  project?: AndroidProjectReadModel;
  build?: AndroidBuildReadModel;
  run?: AndroidRunReadModel;
  lastError?: string;
}

export interface AndroidServiceSnapshot {
  protocolVersion: typeof ANDROID_PROTOCOL_VERSION;
  serviceEpoch: string;
  sequence: number;
  serviceRevision: number;
  runner: AndroidRunnerSnapshot;
  project?: AndroidProjectReadModel;
  build?: AndroidBuildReadModel;
  run?: AndroidRunReadModel;
  lastError?: string;
}

export interface AndroidServiceEvent {
  protocolVersion: typeof ANDROID_PROTOCOL_VERSION;
  serviceEpoch: string;
  sequence: number;
  serviceRevision: number;
  type: "android.snapshot";
  payload: AndroidServicePayload;
}

interface AndroidCommandBase {
  commandId: string;
  expectedServiceRevision: number;
}

interface AndroidProjectCommandBase extends AndroidCommandBase {
  expectedGeneration: number;
}

export type AndroidCommand =
  | (AndroidCommandBase & { type: "refresh" })
  | (AndroidCommandBase & { type: "startEmulator"; avd: string })
  | (AndroidCommandBase & { type: "cancelOperation"; deviceId: string; deviceRevision: number })
  | (AndroidCommandBase & { type: "stopEmulator"; deviceId: string; deviceRevision: number })
  | (AndroidProjectCommandBase & { type: "refreshProject" })
  | (AndroidProjectCommandBase & {
      type: "saveRunConfiguration";
      expectedConfigRevision: number;
      candidateId: string;
      modulePath: string;
      variant: string;
    })
  | (AndroidProjectCommandBase & {
      type: "setWorkspaceTrust";
      expectedConfigRevision: number;
      expectedTrustRevision: number;
      trusted: boolean;
    })
  | (AndroidProjectCommandBase & { type: "build"; configRevision: number; trustRevision: number })
  | (AndroidProjectCommandBase & {
      type: "buildAndRun";
      configRevision: number;
      trustRevision: number;
      deviceId: string;
      deviceRevision: number;
    })
  | (AndroidCommandBase & { type: "cancelBuild"; operationId: string; operationRevision: number })
  | (AndroidCommandBase & { type: "stopApp"; runId: string; runRevision: number })
  | (AndroidCommandBase & { type: "relaunchApp"; runId: string; runRevision: number })
  | (AndroidCommandBase & { type: "startLogs"; runId: string; runRevision: number })
  | (AndroidCommandBase & { type: "stopLogs"; runId: string; runRevision: number })
  | (AndroidCommandBase & { type: "clearRetainedOutput"; runId: string; runRevision: number });

export interface AndroidCommandResult {
  commandId: string;
  snapshot: AndroidServiceSnapshot;
}

export type AndroidDeviceReadModel = AndroidRunnerDevice;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => key in value);
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function generation(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function baseValid(value: Record<string, unknown>): boolean {
  return typeof value.commandId === "string" && UUID.test(value.commandId) && revision(value.expectedServiceRevision);
}

function projectBaseValid(value: Record<string, unknown>): boolean {
  return baseValid(value) && generation(value.expectedGeneration);
}

export function validateAndroidCommand(value: unknown): AndroidCommand | undefined {
  if (!record(value) || !baseValid(value) || typeof value.type !== "string") return undefined;
  if (value.type === "refresh") {
    return exactKeys(value, ["type", "commandId", "expectedServiceRevision"])
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "startEmulator") {
    return exactKeys(value, ["type", "commandId", "expectedServiceRevision", "avd"]) &&
      typeof value.avd === "string" &&
      value.avd.length > 0 &&
      value.avd.length <= 200 &&
      !/[\r\n\0]/.test(value.avd)
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "cancelOperation" || value.type === "stopEmulator") {
    return exactKeys(value, ["type", "commandId", "expectedServiceRevision", "deviceId", "deviceRevision"]) &&
      typeof value.deviceId === "string" &&
      OPAQUE_ID.test(value.deviceId) &&
      revision(value.deviceRevision)
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "refreshProject") {
    return projectBaseValid(value) &&
      exactKeys(value, ["type", "commandId", "expectedServiceRevision", "expectedGeneration"])
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "saveRunConfiguration") {
    return projectBaseValid(value) &&
      exactKeys(value, [
        "type",
        "commandId",
        "expectedServiceRevision",
        "expectedGeneration",
        "expectedConfigRevision",
        "candidateId",
        "modulePath",
        "variant",
      ]) &&
      revision(value.expectedConfigRevision) &&
      typeof value.candidateId === "string" &&
      OPAQUE_ID.test(value.candidateId) &&
      typeof value.modulePath === "string" &&
      value.modulePath.length <= 160 &&
      MODULE_PATH.test(value.modulePath) &&
      typeof value.variant === "string" &&
      VARIANT.test(value.variant)
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "setWorkspaceTrust") {
    return projectBaseValid(value) &&
      exactKeys(value, [
        "type",
        "commandId",
        "expectedServiceRevision",
        "expectedGeneration",
        "expectedConfigRevision",
        "expectedTrustRevision",
        "trusted",
      ]) &&
      revision(value.expectedConfigRevision) &&
      revision(value.expectedTrustRevision) &&
      typeof value.trusted === "boolean"
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "build") {
    return projectBaseValid(value) &&
      exactKeys(value, [
        "type",
        "commandId",
        "expectedServiceRevision",
        "expectedGeneration",
        "configRevision",
        "trustRevision",
      ]) &&
      revision(value.configRevision) &&
      revision(value.trustRevision)
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "buildAndRun") {
    return projectBaseValid(value) &&
      exactKeys(value, [
        "type",
        "commandId",
        "expectedServiceRevision",
        "expectedGeneration",
        "configRevision",
        "trustRevision",
        "deviceId",
        "deviceRevision",
      ]) &&
      revision(value.configRevision) &&
      revision(value.trustRevision) &&
      typeof value.deviceId === "string" &&
      OPAQUE_ID.test(value.deviceId) &&
      revision(value.deviceRevision)
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (value.type === "cancelBuild") {
    return exactKeys(value, ["type", "commandId", "expectedServiceRevision", "operationId", "operationRevision"]) &&
      typeof value.operationId === "string" &&
      UUID.test(value.operationId) &&
      revision(value.operationRevision)
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  if (["stopApp", "relaunchApp", "startLogs", "stopLogs", "clearRetainedOutput"].includes(value.type)) {
    return exactKeys(value, ["type", "commandId", "expectedServiceRevision", "runId", "runRevision"]) &&
      typeof value.runId === "string" &&
      UUID.test(value.runId) &&
      revision(value.runRevision)
      ? (value as unknown as AndroidCommand)
      : undefined;
  }
  return undefined;
}
