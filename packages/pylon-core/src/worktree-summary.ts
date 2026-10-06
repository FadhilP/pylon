import { activeAssistantEntryIds } from "./work-duration.ts";
import { MAX_TURN_REPOSITORIES, objectId, validSummaryPath } from "./worktree-internal.ts";
import {
  type PersistedWorktreeSummary,
  type TurnAnchor,
  type TurnRepositoryAnchor,
  type WorktreeFileChange,
} from "./worktree-types.ts";

/** Bounded, validated turn summaries persisted in session entries. */

export const WORKTREE_SUMMARY_ENTRY_TYPE = "pylon-worktree-summary";
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_SUMMARY_FILES = 100;
export function validatedTurnRepositories(value: unknown): TurnRepositoryAnchor[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TURN_REPOSITORIES) return undefined;
  const seen = new Set<string>();
  const repositories: TurnRepositoryAnchor[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.path !== "string" ||
      !validSummaryPath(raw.path) ||
      seen.has(raw.path) ||
      typeof raw.beforeTree !== "string" ||
      !objectId.test(raw.beforeTree) ||
      typeof raw.afterTree !== "string" ||
      !objectId.test(raw.afterTree)
    )
      return undefined;
    seen.add(raw.path);
    repositories.push({ path: raw.path, beforeTree: raw.beforeTree, afterTree: raw.afterTree });
  }
  return repositories;
}

export function createWorktreeSummary(
  assistantEntryId: string,
  values: WorktreeFileChange[],
  anchor?: TurnAnchor,
): PersistedWorktreeSummary | undefined {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(assistantEntryId)) return undefined;
  const repositories = validatedTurnRepositories(anchor?.repositories);
  const anchored =
    anchor &&
    repositories &&
    typeof anchor.root === "string" &&
    anchor.root.length > 0 &&
    anchor.root.length <= 1024 &&
    objectId.test(anchor.beforeTree) &&
    objectId.test(anchor.afterTree)
      ? {
          root: anchor.root,
          beforeTree: anchor.beforeTree,
          afterTree: anchor.afterTree,
          ...(repositories.length ? { repositories } : {}),
        }
      : {};
  const summary: PersistedWorktreeSummary = { version: 1, assistantEntryId, files: [], ...anchored };
  for (const value of values.slice(0, MAX_SUMMARY_FILES)) {
    const path = value.path.replaceAll("\\", "/").slice(0, 500);
    if (!validSummaryPath(path)) continue;
    const file =
      value.binary === true
        ? { path, binary: true as const }
        : Number.isSafeInteger(value.additions) && Number.isSafeInteger(value.deletions)
          ? {
              path,
              additions: Math.min(1_000_000, Math.max(0, value.additions!)),
              deletions: Math.min(1_000_000, Math.max(0, value.deletions!)),
            }
          : undefined;
    if (!file) continue;
    const candidate = { ...summary, files: [...summary.files, file] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_SUMMARY_BYTES) break;
    summary.files.push(file);
  }
  return summary;
}

export function parseWorktreeSummary(value: unknown): PersistedWorktreeSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SUMMARY_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.assistantEntryId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.assistantEntryId) ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0 ||
    raw.files.length > MAX_SUMMARY_FILES
  )
    return undefined;

  let anchor: TurnAnchor | undefined;
  if (
    raw.root !== undefined ||
    raw.beforeTree !== undefined ||
    raw.afterTree !== undefined ||
    raw.repositories !== undefined
  ) {
    const repositories = validatedTurnRepositories(raw.repositories);
    if (
      typeof raw.root !== "string" ||
      raw.root.length === 0 ||
      raw.root.length > 1024 ||
      typeof raw.beforeTree !== "string" ||
      !objectId.test(raw.beforeTree) ||
      typeof raw.afterTree !== "string" ||
      !objectId.test(raw.afterTree) ||
      !repositories
    )
      return undefined;
    anchor = {
      root: raw.root,
      beforeTree: raw.beforeTree,
      afterTree: raw.afterTree,
      ...(repositories.length ? { repositories } : {}),
    };
  }

  const files: WorktreeFileChange[] = [];
  for (const value of raw.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const file = value as Record<string, unknown>;
    if (typeof file.path !== "string" || !validSummaryPath(file.path)) return undefined;
    if (file.binary === true) {
      files.push({ path: file.path, binary: true });
      continue;
    }
    if (
      !Number.isSafeInteger(file.additions) ||
      !Number.isSafeInteger(file.deletions) ||
      Number(file.additions) < 0 ||
      Number(file.additions) > 1_000_000 ||
      Number(file.deletions) < 0 ||
      Number(file.deletions) > 1_000_000
    )
      return undefined;
    files.push({ path: file.path, additions: Number(file.additions), deletions: Number(file.deletions) });
  }
  return { version: 1, assistantEntryId: raw.assistantEntryId, files, ...anchor };
}

export function readPersistedWorktreeSummaries(session: {
  getBranch(): unknown[];
  getEntries(): unknown[];
}): Map<string, WorktreeFileChange[]> {
  const activeAssistants = activeAssistantEntryIds(session.getBranch());
  const summaries = new Map<string, WorktreeFileChange[]>();
  for (const value of session.getEntries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== "custom" || entry.customType !== WORKTREE_SUMMARY_ENTRY_TYPE) continue;
    const summary = parseWorktreeSummary(entry.data);
    if (!summary || !activeAssistants.has(summary.assistantEntryId)) continue;
    summaries.set(summary.assistantEntryId, summary.files);
  }
  return summaries;
}
