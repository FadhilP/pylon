import { parsePatchFiles, type CodeViewItem, type FileDiffLoadedChangedFiles } from "@pierre/diffs";

export function createPierreCodeViewItem({
  mode,
  id,
  path,
  text,
  revision,
}: {
  mode: "file" | "diff";
  id: string;
  path: string;
  text: string;
  revision: string;
}): CodeViewItem | undefined {
  if (mode === "file") {
    return {
      id,
      type: "file",
      file: { name: path, contents: text, cacheKey: `${revision}:${path}` },
    };
  }
  try {
    const files = parsePatchFiles(text, `${revision}:${path}`).flatMap((patch) => patch.files);
    if (files.length !== 1) return undefined;
    return { id, type: "diff", fileDiff: files[0]! };
  } catch {
    return undefined;
  }
}

/** Parses a raw unified diff that may contain any number of files into viewer items. */
export function createPierreDiffItems({ id, text, revision }: {
  id: string;
  text: string;
  revision: string;
}): CodeViewItem[] {
  try {
    return parsePatchFiles(text, `${revision}:${id}`).flatMap((patch) => patch.files)
      .map((fileDiff, index) => ({ id: `${id}:${index}`, type: "diff" as const, fileDiff }));
  } catch {
    return [];
  }
}

export function createPierreLoadedDiffFiles({ path, revision, base, current }: {
  path: string;
  revision: string;
  base: { revision: string; state: string; text?: string };
  current: { revision: string; state: string; text?: string };
}): FileDiffLoadedChangedFiles {
  if (base.revision !== revision || current.revision !== revision)
    throw new Error("Workspace changed while loading diff context");
  if (base.state !== "available" || current.state !== "available"
    || base.text === undefined || current.text === undefined)
    throw new Error("Full file context is unavailable");
  return {
    oldFile: { name: path, contents: base.text, cacheKey: `${revision}:${path}:base` },
    newFile: { name: path, contents: current.text, cacheKey: `${revision}:${path}:current` },
  };
}
