import { readFile, writeFile } from "node:fs/promises";
import { capText } from "./result.ts";

export async function saveCheckpoint(path: string, report: string): Promise<void> {
  const text = report.trim();
  if (!text) throw new Error("Checkpoint report must not be empty.");
  await writeFile(path, `${capText(text).text}\n`, { mode: 0o600 });
}

export function repoResult(
  finalText: string,
  error?: string,
  checkpoint?: string,
): string {
  if (!error) return finalText;
  if (error === "Scout timed out." && checkpoint)
    return `Repo scout timed out. Partial checkpoint; verify cited ranges before editing. Do not repeat completed discovery unless a stated gap requires it.\n\n${checkpoint}`;
  return `Repo scout failed nonfatally: ${error}`;
}

export async function loadCheckpoint(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text || undefined;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
