export type HeliosBrowserCommand = {
  expectedGeneration: number;
  action: "status" | "acquire" | "release" | "start" | "close" | "frame" | "navigate" | "back" | "forward" | "reload" | "resize" | "pointer" | "wheel" | "key" | "tab-list" | "tab-new" | "tab-select" | "tab-close";
  url?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  phase?: "move" | "down" | "up";
  button?: "left" | "middle" | "right";
  deltaX?: number;
  deltaY?: number;
  key?: string;
  tabIndex?: number;
};

export type HeliosBrowserInput = HeliosBrowserCommand & { owner: string };

export interface HeliosPageIdentity {
  index: number;
  title: string;
  url: string;
}

export interface HeliosBrowserResult {
  version: 1;
  sessionGeneration: number;
  active: boolean;
  ownership?: "owned" | "cdp-attached" | "extension-attached";
  state?: "starting" | "ready" | "cleanup-required" | "closing" | "closed";
  controlled: boolean;
  page?: HeliosPageIdentity;
  tabs?: HeliosPageIdentity[];
  frame?: { mimeType: "image/png"; data: string };
}

const ACTIONS = new Set<HeliosBrowserCommand["action"]>([
  "status", "acquire", "release", "start", "close", "frame", "navigate", "back", "forward", "reload", "resize",
  "pointer", "wheel", "key", "tab-list", "tab-new", "tab-select", "tab-close",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

export function validateHeliosBrowserCommand(value: unknown): HeliosBrowserCommand | undefined {
  if (!record(value) || !Number.isSafeInteger(value.expectedGeneration) || (value.expectedGeneration as number) <= 0
    || typeof value.action !== "string" || !ACTIONS.has(value.action as HeliosBrowserCommand["action"])) return undefined;
  const input = value as HeliosBrowserCommand;
  const fields: Record<HeliosBrowserCommand["action"], readonly string[]> = {
    status: [], acquire: [], release: [], close: [], frame: [], back: [], forward: [], reload: [], "tab-list": [],
    start: ["url", "width", "height"], navigate: ["url"], resize: ["width", "height"],
    pointer: ["x", "y", "phase", "button"], wheel: ["x", "y", "deltaX", "deltaY"], key: ["phase", "key"],
    "tab-new": ["url"], "tab-select": ["tabIndex"], "tab-close": ["tabIndex"],
  };
  const allowed = new Set(["action", "expectedGeneration", ...fields[input.action]]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (input.url !== undefined && (typeof input.url !== "string" || !input.url || input.url.length > 4096)) return undefined;
  if (input.action === "start" || input.action === "resize") {
    if (!integer(input.width, 320, 1920) || !integer(input.height, 240, 1080)) return undefined;
  }
  if (input.action === "pointer") {
    if (!integer(input.x, 0, 4096) || !integer(input.y, 0, 4096)
      || !["move", "down", "up"].includes(String(input.phase))
      || input.phase !== "move" && !["left", "middle", "right"].includes(String(input.button))) return undefined;
  }
  if (input.action === "wheel") {
    if (!integer(input.x, 0, 4096) || !integer(input.y, 0, 4096)
      || !integer(input.deltaX, -5000, 5000) || !integer(input.deltaY, -5000, 5000)) return undefined;
  }
  if (input.action === "key" && (!input.key || input.key.length > 64 || /[\r\n\0]/u.test(input.key)
    || !["down", "up"].includes(String(input.phase)))) return undefined;
  if ((input.action === "tab-select" || input.action === "tab-close") && !integer(input.tabIndex, 0, 100)) return undefined;
  if (input.action === "navigate" && !input.url) return undefined;
  return { ...input };
}
