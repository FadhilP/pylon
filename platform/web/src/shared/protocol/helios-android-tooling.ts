export type HeliosAndroidToolingCommand =
  | { expectedGeneration: number; action: "status" }
  | {
      expectedGeneration: number;
      action: "install" | "remove";
      confirmed: true;
    };

export type HeliosAndroidToolingInput =
  { action: "status" } | { action: "install" | "remove"; confirmed: true };

export interface HeliosAndroidToolingResult {
  version: 1;
  sessionGeneration: number;
  state: "missing" | "ready" | "invalid" | "busy";
  appiumVersion: string;
  driverVersion: string;
  message?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateHeliosAndroidToolingCommand(
  value: unknown,
): HeliosAndroidToolingCommand | undefined {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    (value.expectedGeneration as number) <= 0
  )
    return undefined;
  const expectedGeneration = value.expectedGeneration as number;
  if (value.action === "status") {
    if (
      Object.keys(value).some(
        (key) => key !== "expectedGeneration" && key !== "action",
      )
    )
      return undefined;
    return { expectedGeneration, action: "status" };
  }
  if (
    (value.action !== "install" && value.action !== "remove") ||
    value.confirmed !== true
  )
    return undefined;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "expectedGeneration" && key !== "action" && key !== "confirmed",
    )
  )
    return undefined;
  return { expectedGeneration, action: value.action, confirmed: true };
}
