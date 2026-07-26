export function displayTime(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "Unknown" : new Date(time).toLocaleString();
}

export function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}

export function thinkingLabel(level: string): string {
  if (level === "xhigh") return "Extra high";
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}
