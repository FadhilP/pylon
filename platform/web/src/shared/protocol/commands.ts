import type { GuardRuleOverrides } from "../guard-policy.ts";
import type {
  DialogTimeoutSeconds,
  HookSettingsReadModel,
  PackageSettingsReadModel,
  ToolExposureMode,
  VerifyPolicyReadModel,
  WorkspacePolicyMode,
} from "./snapshots.ts";

export const COMMAND_NAMES = [
  "prompt",
  "queuePrompt",
  "restoreQueuedPrompt",
  "steerQueuedPrompt",
  "steer",
  "followUp",
  "abort",
  "addProject",
  "removeProject",
  "renameProject",
  "reorderProject",
  "archiveProject",
  "restoreProject",
  "newSession",
  "switchSession",
  "deleteSession",
  "archiveSession",
  "restoreSession",
  "renameSession",
  "setSessionActive",
  "setSessionPinned",
  "reorderActiveSession",
  "checkoutBranch",
  "editPrompt",
  "rewindPrompt",
  "fork",
  "timeline",
  "setPackageEnabled",
  "updatePackageSettings",
  "setExtensionEnabled",
  "installExtensionPackage",
  "removeExtensionPackage",
  "setProjectTrust",
  "reloadExtensions",
  "updateHookSettings",
  "rebuildDiscoverIndex",
  "setModel",
  "setThinkingLevel",
  "setSessionControls",
  "startProviderLogin",
  "cancelProviderLogin",
  "logoutProvider",
  "updateContinuityMemory",
  "deleteContinuityMemory",
  "migrateContinuityMemory",
  "continuityPlanAction",
  "handoffSession",
  "applySessionChanges",
  "updateProjectWorktreeSettings",
  "updateRuntimePolicy",
  "updateToolPolicy",
  "dismissCommandResult",
] as const;

interface CommandBase {
  commandId: string;
  expectedGeneration: number;
}

export interface PromptImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface PromptTextFile {
  name: string;
  text: string;
  size: number;
  mimeType?: string;
}

interface MessageCommand extends CommandBase {
  message: string;
  images?: PromptImage[];
  files?: PromptTextFile[];
}

interface PromptCommand extends MessageCommand {
  planMode?: boolean;
}

export type WebCommand =
  | ({ type: "prompt" } & PromptCommand)
  | ({ type: "queuePrompt" } & PromptCommand)
  | ({ type: "restoreQueuedPrompt"; queueId: string } & CommandBase)
  | ({ type: "steerQueuedPrompt"; queueId: string } & CommandBase)
  | ({ type: "steer" } & MessageCommand)
  | ({ type: "followUp" } & MessageCommand)
  | ({ type: "abort" } & CommandBase)
  | ({ type: "addProject" } & CommandBase)
  | ({ type: "removeProject"; projectId: string } & CommandBase)
  | ({ type: "renameProject"; projectId: string; name: string } & CommandBase)
  | ({ type: "reorderProject"; projectId: string; beforeProjectId?: string } & CommandBase)
  | ({ type: "archiveProject"; projectId: string } & CommandBase)
  | ({ type: "restoreProject"; projectId: string } & CommandBase)
  | ({ type: "newSession"; parentSessionId?: string; projectId?: string } & CommandBase)
  | ({ type: "switchSession"; sessionId: string } & CommandBase)
  | ({ type: "deleteSession"; sessionId: string } & CommandBase)
  | ({ type: "archiveSession"; sessionId: string } & CommandBase)
  | ({ type: "restoreSession"; sessionId: string } & CommandBase)
  | ({ type: "renameSession"; sessionId: string; name: string } & CommandBase)
  | ({ type: "setSessionActive"; sessionId: string; active: boolean } & CommandBase)
  | ({ type: "setSessionPinned"; sessionId: string; pinned: boolean } & CommandBase)
  | ({ type: "reorderActiveSession"; sessionId: string; beforeSessionId?: string } & CommandBase)
  | ({ type: "checkoutBranch"; branch: string } & CommandBase)
  | ({ type: "editPrompt"; entryId: string; rollbackFiles: boolean } & MessageCommand)
  | ({ type: "rewindPrompt"; entryId: string } & CommandBase)
  | ({
      type: "fork";
      entryId: string;
      name: string;
      position?: "before" | "at";
      mode?: "conversation" | "timeline";
    } & CommandBase)
  | ({ type: "timeline"; action: "restore" | "fork" | "clear"; checkpointId?: string } & CommandBase)
  | ({ type: "setPackageEnabled"; packageId: string; enabled: boolean } & CommandBase)
  | ({ type: "updatePackageSettings"; packageId: string; settings: PackageSettingsReadModel } & CommandBase)
  | ({ type: "setExtensionEnabled"; extensionId: string; enabled: boolean } & CommandBase)
  | ({
      type: "installExtensionPackage";
      source: string;
      scope: "user" | "project";
      projectId?: string;
      confirmed: true;
    } & CommandBase)
  | ({ type: "removeExtensionPackage"; source: string; scope: "user" | "project"; confirmed: true } & CommandBase)
  | ({ type: "setProjectTrust"; trusted: boolean; confirmed: true } & CommandBase)
  | ({ type: "reloadExtensions"; confirmed: true } & CommandBase)
  | ({ type: "updateHookSettings"; settings: HookSettingsReadModel } & CommandBase)
  | ({ type: "rebuildDiscoverIndex" } & CommandBase)
  | ({ type: "setModel"; provider: string; modelId: string } & CommandBase)
  | ({ type: "setThinkingLevel"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } & CommandBase)
  | ({
      type: "setSessionControls";
      provider: string;
      modelId: string;
      thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    } & CommandBase)
  | ({ type: "startProviderLogin"; provider: string; authType: "api_key" | "oauth" } & CommandBase)
  | ({ type: "cancelProviderLogin" } & CommandBase)
  | ({ type: "logoutProvider"; provider: string } & CommandBase)
  | ({
      type: "updateContinuityMemory";
      scope: "user" | "project";
      id: string;
      trigger: string;
      guidance: string;
      expectedRevision: number;
    } & CommandBase)
  | ({ type: "deleteContinuityMemory"; scope: "user" | "project"; id: string; expectedRevision: number } & CommandBase)
  | ({ type: "migrateContinuityMemory" } & CommandBase)
  | ({ type: "continuityPlanAction"; expectedRevision: number } & (
      { action: "approve"; resetContext: boolean } | { action: "requestChanges"; feedback: string }
    ) &
      CommandBase)
  | ({ type: "handoffSession"; destination: "checkout" | "worktree" } & CommandBase)
  | ({ type: "applySessionChanges"; expectedRevision: string } & CommandBase)
  | ({ type: "updateProjectWorktreeSettings"; projectId: string; setupCommand: string } & CommandBase)
  | ({
      type: "updateRuntimePolicy";
      scope: "global" | "project" | "session";
      verify: VerifyPolicyReadModel | { mode: "inherit" };
      timeline: "inherit" | "enabled" | "disabled";
      guard: "inherit" | "enabled" | "disabled";
      guardRules: GuardRuleOverrides;
      workspace: WorkspacePolicyMode | "inherit";
      guardTimeoutSeconds: DialogTimeoutSeconds | "inherit";
      clarifyTimeoutSeconds: DialogTimeoutSeconds | "inherit";
      expectedRevision: number;
    } & CommandBase)
  | ({
      type: "updateToolPolicy";
      scope: "global" | "project" | "session";
      tool: string;
      mode: ToolExposureMode | "inherit";
      expectedRevision: number;
    } & CommandBase)
  | ({ type: "dismissCommandResult"; resultId: string } & CommandBase);

export interface AcceptedCommand {
  commandId: string;
  sessionGeneration: number;
  accepted: true;
}

export interface QueuedPromptPayload {
  id: string;
  message: string;
  images?: PromptImage[];
  files?: PromptTextFile[];
  planMode: boolean;
}
