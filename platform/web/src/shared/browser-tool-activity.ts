import type { ToolActivityReadModel } from "./protocol/events.ts";

export function startsHeliosBrowser(tool: ToolActivityReadModel): boolean {
  if (tool.name !== "helios_browser" || !tool.input) return false;
  try {
    const input = JSON.parse(tool.input) as { action?: unknown; actions?: Array<{ action?: unknown }> };
    return input.action === "start" || Array.isArray(input.actions) && input.actions.some((action) => action?.action === "start");
  } catch {
    return false;
  }
}
