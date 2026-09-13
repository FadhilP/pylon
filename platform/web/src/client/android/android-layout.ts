export type AndroidOutputKind = "build" | "logs";
export type AndroidBottomTab = "terminal" | AndroidOutputKind;

export interface AndroidDockLayout {
  build: boolean;
  logs: boolean;
  active: AndroidBottomTab;
}

export type AndroidRunPhase =
  | "building"
  | "inspecting"
  | "installing"
  | "launching"
  | "running"
  | "stopped"
  | "cancelled"
  | "failed";

export interface AndroidRunPhaseStep {
  at: 0 | 1 | 2 | 3 | 4;
  tone: "active" | "warning" | "danger";
}

export interface StorageReader {
  getItem(key: string): string | null;
}

export const ANDROID_OUTPUT_SPLIT_KEY = "pylon-android-output-split";
export const DEFAULT_ANDROID_DOCK_LAYOUT: AndroidDockLayout = {
  build: false,
  logs: false,
  active: "terminal",
};

export function dockAndroidOutput(layout: AndroidDockLayout, output: AndroidOutputKind): AndroidDockLayout {
  return { ...layout, [output]: true, active: output };
}

export function restoreAndroidOutput(layout: AndroidDockLayout, output: AndroidOutputKind): AndroidDockLayout {
  const next = { ...layout, [output]: false };
  if (layout.active !== output) return next;
  const other: AndroidOutputKind = output === "build" ? "logs" : "build";
  return { ...next, active: next[other] ? other : "terminal" };
}

export function closeTerminalTab(layout: AndroidDockLayout): AndroidDockLayout {
  if (layout.active !== "terminal") return layout;
  return { ...layout, active: layout.build ? "build" : layout.logs ? "logs" : "terminal" };
}

export function androidRunPhaseStep(
  phase: AndroidRunPhase,
  state: { buildSucceeded: boolean; hasArtifact: boolean; installed: boolean },
): AndroidRunPhaseStep {
  const direct: Partial<Record<AndroidRunPhase, 0 | 1 | 2 | 3 | 4>> = {
    building: 0,
    inspecting: 1,
    installing: 2,
    launching: 3,
    running: 4,
  };
  const current = direct[phase];
  if (current !== undefined) return { at: current, tone: "active" };
  const at = !state.buildSucceeded ? 0 : !state.hasArtifact ? 1 : !state.installed ? 2 : 3;
  return { at, tone: phase === "failed" ? "danger" : "warning" };
}

export function readAndroidOutputSplit(storage: StorageReader | undefined): number | undefined {
  if (!storage) return undefined;
  try {
    const value = Number(storage.getItem(ANDROID_OUTPUT_SPLIT_KEY));
    return Number.isFinite(value) && value >= 0.1 && value <= 0.9 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clampAndroidOutputSplit(value: number, minimum = 0.1): number {
  const floor = Math.max(0.1, Math.min(0.49, minimum));
  return Math.min(1 - floor, Math.max(floor, value));
}

export function moveAndroidOutputSplit(
  current: number,
  key: string,
  shiftKey = false,
  minimum = 0.1,
): number | undefined {
  const step = shiftKey ? 0.1 : 0.03;
  if (key === "ArrowUp") return clampAndroidOutputSplit(current - step, minimum);
  if (key === "ArrowDown") return clampAndroidOutputSplit(current + step, minimum);
  if (key === "Home") return clampAndroidOutputSplit(0, minimum);
  if (key === "End") return clampAndroidOutputSplit(1, minimum);
  return undefined;
}
