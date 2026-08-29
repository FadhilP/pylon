import {
  classifyCompatibility,
  type Compatibility,
  type GitState,
} from "./compatibility.ts";
import { git, symbolicHead } from "./git.ts";
import type { Bound } from "./records.ts";
import type { Snapshot } from "./snapshot.ts";

export const inspectGitState = async (cwd: string): Promise<GitState> => {
  const [gitRoot, commonDir, head, headRef] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(cwd, ["rev-parse", "HEAD"]),
    symbolicHead(cwd),
  ]);
  return { gitRoot, commonDir, head, headRef };
};

export const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");
const refName = (ref: string | null) =>
  ref === null ? "detached HEAD" : shortRef(ref);

/**
 * The one place a checkpoint's compatibility is turned into words, so the short label
 * shown in a list and the prose shown in a confirmation can never describe it differently.
 */
export const describeCompatibility = (
  target: Snapshot,
  current: GitState,
  result: Compatibility = classifyCompatibility(target, current),
): { label: string; detail: string } => {
  if (!result.allowed)
    return result.reason === "repository-mismatch"
      ? {
          label: "[blocked:repository]",
          detail: "Checkpoint belongs to a different repository.",
        }
      : {
          label: "[blocked:HEAD]",
          detail: "Checkpoint HEAD commit differs from current HEAD.",
        };

  const divergedDetail =
    `HEAD commit matches, but checkpoint used ${refName(target.headRef)} and current state uses ${refName(current.headRef)}. ` +
    "Restore updates index and working tree only; it does not switch branches.";
  if (result.refState === "target-detached")
    return { label: "[checkpoint:detached]", detail: divergedDetail };
  if (result.refState === "current-detached")
    return { label: "[current:detached]", detail: divergedDetail };
  if (result.refState === "ref-mismatch")
    return {
      label: `[branch:${shortRef(target.headRef!)}; current:${shortRef(current.headRef!)}]`,
      detail: divergedDetail,
    };
  return target.headRef === null
    ? {
        label: "[detached]",
        detail:
          "Checkpoint and current state use detached HEAD at the same commit.",
      }
    : {
        label: `[branch:${shortRef(target.headRef!)}]`,
        detail: `Checkpoint branch: ${shortRef(target.headRef!)}. HEAD commit matches.`,
      };
};

export const compatibilityLabel = (
  target: Snapshot,
  current: GitState,
  result?: Compatibility,
) => describeCompatibility(target, current, result).label;
export const compatibilityDetail = (
  target: Snapshot,
  current: GitState,
  result?: Compatibility,
) => describeCompatibility(target, current, result).detail;
export const checkpointRow = (bound: Bound, current: GitState) =>
  `${compatibilityLabel(bound.record, current)} ${bound.record.createdAt.replace(/\.\d{3}Z$/, "Z")} ${bound.preview}`;
