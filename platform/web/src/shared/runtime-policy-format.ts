export type TimeoutUnit = "seconds" | "minutes" | "hours";

export const timeoutUnitSeconds: Record<TimeoutUnit, number> = { seconds: 1, minutes: 60, hours: 3_600 };

export function timeoutParts(value: number): { amount: number; unit: TimeoutUnit } {
  if (value % 3_600 === 0) return { amount: value / 3_600, unit: "hours" };
  if (value % 60 === 0) return { amount: value / 60, unit: "minutes" };
  return { amount: value, unit: "seconds" };
}
