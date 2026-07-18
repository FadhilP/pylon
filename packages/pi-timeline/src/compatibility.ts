import { resolve } from "node:path";

export type GitState = {
  gitRoot: string;
  head: string;
  headRef?: string | null;
};

export type Compatibility =
  | { allowed: false; reason: "repository-mismatch" | "head-mismatch" }
  | {
      allowed: true;
      refState:
        | "legacy"
        | "same"
        | "target-detached"
        | "current-detached"
        | "ref-mismatch";
    };

const canonical = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function classifyCompatibility(
  target: GitState,
  current: GitState,
): Compatibility {
  if (canonical(target.gitRoot) !== canonical(current.gitRoot))
    return { allowed: false, reason: "repository-mismatch" };
  if (target.head !== current.head)
    return { allowed: false, reason: "head-mismatch" };
  if (target.headRef === undefined)
    return { allowed: true, refState: "legacy" };
  if (target.headRef === current.headRef)
    return { allowed: true, refState: "same" };
  if (target.headRef === null)
    return { allowed: true, refState: "target-detached" };
  if (current.headRef === null)
    return { allowed: true, refState: "current-detached" };
  return { allowed: true, refState: "ref-mismatch" };
}
