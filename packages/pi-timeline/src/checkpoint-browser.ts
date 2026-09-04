import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TimelineChangeSet } from "./changes.ts";

export type CheckpointBrowserItem = {
  id: string;
  title: string;
  createdAt: string;
  status: string;
  branch?: string;
  changes?: Pick<TimelineChangeSet, "fileCount" | "additions" | "deletions"> &
    Partial<Pick<TimelineChangeSet, "files">>;
};

export type CheckpointBrowserResult = { id: string; mode: "jump" | "fork" };

const pad = (value: string, width: number) => value + " ".repeat(Math.max(0, width - visibleWidth(value)));

const fitPair = (left: string, right: string, width: number) => {
  if (!right) return truncateToWidth(left, width, "…");
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return sliceByColumn(right, 0, width, true);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth, "…");
  return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth))}${right}`;
};

const clock = (createdAt: string) => {
  const date = new Date(createdAt);
  return Number.isNaN(date.valueOf()) ? "--:--:--" : date.toISOString().slice(11, 19);
};

export class CheckpointBrowser {
  private selected = 0;
  private query = "";
  private filtering = false;
  private readonly items: CheckpointBrowserItem[];
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly done: (result: CheckpointBrowserResult | undefined) => void;

  constructor(
    items: CheckpointBrowserItem[],
    theme: Theme,
    requestRender: () => void,
    done: (result: CheckpointBrowserResult | undefined) => void,
  ) {
    this.items = items;
    this.theme = theme;
    this.requestRender = requestRender;
    this.done = done;
  }

  private filteredItems() {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.items;
    return this.items.filter(item => `${item.title} ${item.status} ${item.branch ?? ""}`.toLowerCase().includes(query));
  }

  private move(delta: number) {
    const items = this.filteredItems();
    if (!items.length) return;
    this.selected = Math.max(0, Math.min(items.length - 1, this.selected + delta));
    this.requestRender();
  }

  private choose(mode: "jump" | "fork") {
    const item = this.filteredItems()[this.selected];
    if (item) this.done({ id: item.id, mode });
  }

  handleInput(data: string): void {
    if (this.filtering) {
      if (matchesKey(data, "escape") || matchesKey(data, "return")) {
        this.filtering = false;
      } else if (matchesKey(data, "backspace")) {
        this.query = this.query.slice(0, -1);
        this.selected = 0;
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.query += data;
        this.selected = 0;
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done(undefined);
    else if (matchesKey(data, "up") || data === "k") this.move(-1);
    else if (matchesKey(data, "down") || data === "j") this.move(1);
    else if (matchesKey(data, "return")) this.choose("jump");
    else if (data === "f") this.choose("fork");
    else if (data === "/") {
      this.filtering = true;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const line = (value = "") => `${border("│")}${pad(truncateToWidth(value, inner, "…"), inner)}${border("│")}`;
    const items = this.filteredItems();
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, items.length - 1)));
    const visibleCount = Math.min(5, Math.max(1, items.length));
    const offset = Math.max(0, Math.min(this.selected - visibleCount + 1, items.length - visibleCount));
    const visible = items.slice(offset, offset + visibleCount);
    const filter = this.query ? ` · filter: ${this.query}` : this.filtering ? " · filter: " : "";
    const title = fitPair(
      this.theme.fg("borderAccent", this.theme.bold(" Checkpoints")),
      this.theme.fg("dim", `${items.length}/${this.items.length}${filter}`),
      inner,
    );
    const rows = [border(`┌${"─".repeat(inner)}┐`), line(title), line()];

    if (!visible.length) rows.push(line(this.theme.fg("warning", "  No matching checkpoints")));
    for (const [index, item] of visible.entries()) {
      const absoluteIndex = offset + index;
      const active = absoluteIndex === this.selected;
      const prefix = active ? this.theme.fg("accent", " ▸") : "  ";
      const time = this.theme.fg(active ? "accent" : "dim", clock(item.createdAt));
      const left = `${prefix} ${time}  ${this.theme.fg(active ? "text" : "muted", item.title)}`;
      const right = this.theme.fg(item.status.startsWith("[blocked") ? "warning" : "dim", item.branch ?? item.status);
      rows.push(line(fitPair(left, right, inner)));
    }
    while (rows.length < 8) rows.push(line());

    const selected = items[this.selected];
    rows.push(border(`├${"─".repeat(inner)}┤`));
    if (selected?.changes) {
      const changes = selected.changes;
      const files =
        changes.files
          ?.slice(0, 3)
          .map(file => file.path)
          .join(", ") ?? "";
      const summary = `${changes.fileCount} files · +${changes.additions} −${changes.deletions}${files ? ` · ${files}` : ""}`;
      rows.push(line(` ${this.theme.fg("dim", summary)}`));
    } else {
      rows.push(line(` ${this.theme.fg("dim", selected?.title ?? "No checkpoint selected")}`));
    }
    const hint = this.filtering
      ? " type to filter   enter apply   esc stop filtering"
      : " ↑↓ move   enter view   f fork   / filter   esc close";
    rows.push(line(this.theme.fg("dim", hint)));
    rows.push(border(`└${"─".repeat(inner)}┘`));
    return rows;
  }

  invalidate(): void {}
}
