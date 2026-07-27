import type { PackageSettingsReadModel } from "./snapshots.ts";

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
  "reorderActiveSession",
  "editPrompt",
  "rewindPrompt",
  "fork",
  "timeline",
  "setPackageEnabled",
  "updatePackageSettings",
  "rebuildDiscoverIndex",
  "setModel",
  "setThinkingLevel",
  "setSessionControls",
  "updateContinuityMemory",
  "deleteContinuityMemory",
  "handoffSession",
  "updateProjectWorktreeSettings",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

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
  | ({ type: "reorderActiveSession"; sessionId: string; beforeSessionId?: string } & CommandBase)
  | ({ type: "editPrompt"; entryId: string; rollbackFiles: boolean } & MessageCommand)
  | ({ type: "rewindPrompt"; entryId: string } & CommandBase)
  | ({ type: "fork"; entryId: string; position?: "before" | "at" } & CommandBase)
  | ({ type: "timeline"; action: "restore" | "fork" | "clear"; checkpointId?: string } & CommandBase)
  | ({ type: "setPackageEnabled"; packageId: string; enabled: boolean } & CommandBase)
  | ({ type: "updatePackageSettings"; packageId: string; settings: PackageSettingsReadModel } & CommandBase)
  | ({ type: "rebuildDiscoverIndex" } & CommandBase)
  | ({ type: "setModel"; provider: string; modelId: string } & CommandBase)
  | ({ type: "setThinkingLevel"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } & CommandBase)
  | ({ type: "setSessionControls"; provider: string; modelId: string; thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } & CommandBase)
  | ({ type: "updateContinuityMemory"; key: string; text: string; kind: "workflow" | "structure" | "architecture" | "warning" | "preference"; expectedUpdatedAt: string } & CommandBase)
  | ({ type: "deleteContinuityMemory"; key: string; expectedUpdatedAt: string } & CommandBase)
  | ({ type: "handoffSession"; destination: "checkout" | "worktree" } & CommandBase)
  | ({ type: "updateProjectWorktreeSettings"; projectId: string; setupCommand: string } & CommandBase);

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
