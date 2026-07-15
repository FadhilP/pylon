import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export type Density = "compact" | "comfortable";

export function plainText(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function composeStatuses(statuses: string[], fallback: string): string {
  return statuses.length ? statuses.join(" · ") : fallback;
}

export function fitPair(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return sliceByColumn(right, 0, width, true);
  const room = width - rightWidth - 1,
    clippedLeft = sliceByColumn(left, 0, room, true),
    gap = width - visibleWidth(clippedLeft) - rightWidth;
  return clippedLeft + " ".repeat(Math.max(1, gap)) + right;
}

export function footerRows(
  width: number,
  density: Density,
  workspace: string,
  branch: string | null,
  session: string,
  state: string,
  usage: string,
): string[] {
  const location = `${workspace}${branch ? `:${branch}` : ""}`;
  const primary = fitPair(`${session} · ${location} · ${state}`, usage, width);
  return density === "comfortable" && width >= 80
    ? [primary, fitPair("", "Ctrl+O tools · Ctrl+P model", width)]
    : [primary];
}

export function shortWorkspace(cwd: string): string {
  return cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || cwd;
}
