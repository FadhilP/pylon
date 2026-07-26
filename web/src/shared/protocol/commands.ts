import type { PackageSettingsReadModel } from "./snapshots.ts";

export const COMMAND_NAMES = [
  "prompt",
  "steer",
  "followUp",
  "abort",
  "addProject",
  "removeProject",
  "archiveProject",
  "restoreProject",
  "newSession",
  "switchSession",
  "deleteSession",
  "archiveSession",
  "restoreSession",
  "renameSession",
  "setSessionActive",
  "fork",
  "timeline",
  "setPackageEnabled",
  "updatePackageSettings",
  "rebuildDiscoverIndex",
  "setModel",
  "setThinkingLevel",
  "updateContinuityMemory",
  "deleteContinuityMemory",
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

interface MessageCommand extends CommandBase {
  message: string;
  images?: PromptImage[];
}

export type WebCommand =
  | ({ type: "prompt" } & MessageCommand)
  | ({ type: "steer" } & MessageCommand)
  | ({ type: "followUp" } & MessageCommand)
  | ({ type: "abort" } & CommandBase)
  | ({ type: "addProject" } & CommandBase)
  | ({ type: "removeProject"; projectId: string } & CommandBase)
  | ({ type: "archiveProject"; projectId: string } & CommandBase)
  | ({ type: "restoreProject"; projectId: string } & CommandBase)
  | ({ type: "newSession"; parentSessionId?: string; projectId?: string } & CommandBase)
  | ({ type: "switchSession"; sessionId: string } & CommandBase)
  | ({ type: "deleteSession"; sessionId: string } & CommandBase)
  | ({ type: "archiveSession"; sessionId: string } & CommandBase)
  | ({ type: "restoreSession"; sessionId: string } & CommandBase)
  | ({ type: "renameSession"; sessionId: string; name: string } & CommandBase)
  | ({ type: "setSessionActive"; sessionId: string; active: boolean } & CommandBase)
  | ({ type: "fork"; entryId: string; position?: "before" | "at" } & CommandBase)
  | ({ type: "timeline"; action: "restore" | "fork" | "clear"; checkpointId?: string } & CommandBase)
  | ({ type: "setPackageEnabled"; packageId: string; enabled: boolean } & CommandBase)
  | ({ type: "updatePackageSettings"; packageId: string; settings: PackageSettingsReadModel } & CommandBase)
  | ({ type: "rebuildDiscoverIndex" } & CommandBase)
  | ({ type: "setModel"; provider: string; modelId: string } & CommandBase)
  | ({ type: "setThinkingLevel"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } & CommandBase)
  | ({ type: "updateContinuityMemory"; key: string; text: string; kind: "workflow" | "structure" | "architecture" | "warning" | "preference"; expectedUpdatedAt: string } & CommandBase)
  | ({ type: "deleteContinuityMemory"; key: string; expectedUpdatedAt: string } & CommandBase);

export interface AcceptedCommand {
  commandId: string;
  sessionGeneration: number;
  accepted: true;
}
