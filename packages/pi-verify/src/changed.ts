import { isAbsolute, relative, resolve } from "node:path";
import type { Check, Detection } from "./detect.ts";

const LIMIT = 6;
const inside = (root: string, path: string) => {
  const value = relative(root, path);
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
};

/** Selects affected package checks, or returns undefined when full verification is safer. */
export function checksForChangedPaths(
  cwd: string,
  detection: Detection,
  paths: readonly string[],
): { checks: Check[]; omitted: Check[]; complete: boolean } | undefined {
  if (!paths.length) return undefined;
  const root = resolve(cwd);
  const packageRoots = detection.packageRoots.slice().sort((a, b) => b.length - a.length);
  const affected = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!inside(root, absolute)) return undefined;
    const owner = packageRoots.find(packageRoot => inside(packageRoot, absolute));
    if (!owner) return undefined;
    affected.add(owner);
  }
  const available = detection.available.filter(check => affected.has(check.cwd));
  if ([...affected].some(packageRoot => !available.some(check => check.cwd === packageRoot))) return undefined;
  if (available.length <= LIMIT) return { checks: available, omitted: [], complete: true };
  const rootChecks = detection.available.filter(check => check.cwd === root);
  if (rootChecks.length) return { checks: detection.checks, omitted: detection.omitted, complete: true };
  return { checks: available.slice(0, LIMIT), omitted: available.slice(LIMIT), complete: false };
}
