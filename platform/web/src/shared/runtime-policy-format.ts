import type {
  DialogTimeoutSeconds,
  RuntimePolicyReadModel,
} from "./protocol/snapshots.ts";

export type TimeoutUnit = "seconds" | "minutes" | "hours";
export type RuntimePolicySource = "Global" | "Project" | "This session";

export const timeoutUnitSeconds: Record<TimeoutUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3_600,
};

export function timeoutParts(value: number): {
  amount: number;
  unit: TimeoutUnit;
} {
  if (value % 3_600 === 0) return { amount: value / 3_600, unit: "hours" };
  if (value % 60 === 0) return { amount: value / 60, unit: "minutes" };
  return { amount: value, unit: "seconds" };
}

export function formatPolicyTimeout(value: DialogTimeoutSeconds): string {
  if (value === null) return "Never";
  const { amount, unit } = timeoutParts(value);
  const singular = amount === 1 ? unit.slice(0, -1) : unit;
  return `${amount} ${singular}`;
}

export function runtimePolicySources(
  policy: RuntimePolicyReadModel,
): Record<
  | "verify"
  | "timeline"
  | "guard"
  | "workspace"
  | "guardTimeout"
  | "clarifyTimeout",
  RuntimePolicySource
> {
  const source = (
    sessionValue: unknown,
    projectValue: unknown,
  ): RuntimePolicySource =>
    sessionValue !== undefined
      ? "This session"
      : projectValue !== undefined
        ? "Project"
        : "Global";
  return {
    verify: policy.session.verify ? "This session" : "Project",
    timeline: source(
      policy.session.timelineEnabled,
      policy.project.timelineEnabled,
    ),
    guard: source(policy.session.guardEnabled, policy.project.guardEnabled),
    workspace: source(policy.session.workspace, policy.project.workspace),
    guardTimeout: source(
      policy.session.guardTimeoutSeconds,
      policy.project.guardTimeoutSeconds,
    ),
    clarifyTimeout: source(
      policy.session.clarifyTimeoutSeconds,
      policy.project.clarifyTimeoutSeconds,
    ),
  };
}
