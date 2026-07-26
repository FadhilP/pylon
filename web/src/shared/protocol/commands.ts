export const COMMAND_NAMES = [
  "prompt",
  "steer",
  "followUp",
  "abort",
  "newSession",
  "switchSession",
  "deleteSession",
  "fork",
  "timeline",
  "setPackageEnabled",
  "setModel",
  "setThinkingLevel",
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
  | ({ type: "newSession"; parentSessionId?: string } & CommandBase)
  | ({ type: "switchSession"; sessionId: string } & CommandBase)
  | ({ type: "deleteSession"; sessionId: string } & CommandBase)
  | ({ type: "fork"; entryId: string; position?: "before" | "at" } & CommandBase)
  | ({ type: "timeline"; action: "restore" | "fork" | "clear"; checkpointId?: string } & CommandBase)
  | ({ type: "setPackageEnabled"; packageId: string; enabled: boolean } & CommandBase)
  | ({ type: "setModel"; provider: string; modelId: string } & CommandBase)
  | ({ type: "setThinkingLevel"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } & CommandBase);

export interface AcceptedCommand {
  commandId: string;
  sessionGeneration: number;
  accepted: true;
}
