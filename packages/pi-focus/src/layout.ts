import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export type Density = "compact" | "comfortable";

function fitPair(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return sliceByColumn(right, 0, width, true);
  const room = width - rightWidth - 1;
  const clippedLeft = sliceByColumn(left, 0, room, true);
  const gap = width - visibleWidth(clippedLeft) - rightWidth;
  return clippedLeft + " ".repeat(Math.max(1, gap)) + right;
}

/** Keeps state at the left and clips lower-priority identity fields before right-side usage. */
export function footerRows(
  width: number,
  state: string,
  session: string,
  branch: string | null,
  usage: string,
  context: string,
): string[] {
  const identity = `${state}  ${session}${width >= 80 && branch ? `  ${branch}` : ""}`;
  const metrics = width >= 80 ? `${usage}  ${context}` : context;
  return [fitPair(identity, metrics, width)];
}

export function shortWorkspace(cwd: string): string {
  return cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || cwd;
}
