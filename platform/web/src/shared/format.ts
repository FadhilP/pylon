import type { ModelOptionReadModel } from "./protocol/events.ts";

export function formatWorkDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "Unknown";

  const elapsed = Math.max(0, now - time);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const units = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "K" },
  ];
  const unit = units.find((item) => absolute >= item.value);
  if (!unit) return Math.round(value).toLocaleString();
  const scaled = value / unit.value;
  const rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
  return `${rounded}${unit.suffix}`;
}

export function modelLabel(reference: string, models: ModelOptionReadModel[]): string {
  const match = models.find((model) =>
    reference === model.name
    || reference === model.id
    || reference === `${model.provider}/${model.id}`);
  if (match) return match.name;
  const id = reference.split("/").at(-1) ?? reference;
  const parts = id.split(/[-_]+/);
  const prefix = /^gpt$/i.test(parts[0] ?? "") && /^\d/.test(parts[1] ?? "")
    ? [`GPT-${parts[1]}`, ...parts.slice(2)]
    : parts;
  return prefix.map((part) => part === prefix[0] && part.startsWith("GPT-")
    ? part
    : part ? part[0]!.toUpperCase() + part.slice(1) : "").join(" ");
}
