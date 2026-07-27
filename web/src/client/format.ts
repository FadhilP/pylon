export function displayTime(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "Unknown" : new Date(time).toLocaleString();
}

export function displayDate(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "Unknown" : new Date(time).toLocaleDateString();
}

export function displayClockTime(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time)
    ? "Unknown"
    : new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function displayTimelineTime(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "Unknown";
  const date = new Date(time);
  const part = (number: number) => String(number).padStart(2, "0");
  return `${part(date.getDate())}/${part(date.getMonth() + 1)}/${date.getFullYear()}, ${part(date.getHours())}:${part(date.getMinutes())}`;
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
