export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
export type McpExposure = typeof MCP_EXPOSURES[number];
export type McpState = "unknown" | "starting" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "disabled";
export interface McpServerSettings {
  name: string;
  scope: "global" | "project" | "extension";
  projectOverride: boolean;
  transport: "stdio" | "http";
  enabled: boolean;
  exposure: McpExposure;
  state: McpState;
  toolCount?: number;
  writable: boolean;
}
export interface McpSettingsSnapshot {
  sessionId: string;
  sessionGeneration: number;
  available: boolean;
  userConfigPath?: string;
  revision: string;
  servers: McpServerSettings[];
  needsReload: boolean;
  configurationError: boolean;
}
export interface McpSettingsQuery { sessionId: string; expectedGeneration: number }
export type McpSettingsInput =
  | { action: "reload"; confirmed: true }
  | { action: "reconnect"; name: string; confirmed: true }
  | { action: "enabled"; name: string; enabled: boolean; confirmed: true }
  | { action: "exposure"; name: string; exposure: McpExposure; confirmed: true };
export type McpSettingsAction = McpSettingsQuery & McpSettingsInput & { expectedRevision: string };
export function validMcpName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
}
export function validMcpSettingsAction(value: unknown): value is McpSettingsAction {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.sessionId !== "string" || !item.sessionId || item.sessionId.length > 200 ||
      !Number.isSafeInteger(item.expectedGeneration) || (item.expectedGeneration as number) < 0 ||
      typeof item.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(item.expectedRevision) || item.confirmed !== true) return false;
  const keys = ["sessionId", "expectedGeneration", "expectedRevision", "action", "confirmed"];
  if (item.action !== "reload") {
    if (!validMcpName(item.name)) return false;
    keys.push("name");
    if (item.action === "enabled") {
      if (typeof item.enabled !== "boolean") return false;
      keys.push("enabled");
    } else if (item.action === "exposure") {
      if (!MCP_EXPOSURES.includes(item.exposure as McpExposure)) return false;
      keys.push("exposure");
    } else if (item.action !== "reconnect") return false;
  }
  return Object.keys(item).every(key => keys.includes(key));
}
