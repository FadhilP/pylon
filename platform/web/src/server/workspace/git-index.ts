import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_EDIT_BYTES, validWorkspacePath } from "../../shared/workspace/workspace-mutations.ts";

const run = promisify(execFile);

/** Optional comparison data, never an editability decision or a save-version token. */
export async function readGitIndexText(cwd: string, path: string): Promise<string | undefined> {
  if (!validWorkspacePath(path)) return undefined;
  const git = async (...args: string[]) =>
    (
      await run("git", args, {
        cwd,
        encoding: "buffer",
        windowsHide: true,
        timeout: 3000,
        maxBuffer: MAX_EDIT_BYTES + 1,
      })
    ).stdout;
  try {
    const entries = (await git("--literal-pathspecs", "ls-files", "--stage", "-z", "--", path))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (!entries.length) {
      // A failed blob read is not evidence of an untracked file. Ignored/non-Git files have no markers.
      try {
        await git("check-ignore", "-q", "--", path);
      } catch (error: any) {
        if (error.code === 1) return "";
      }
      return undefined;
    }
    if (entries.length !== 1) return undefined; // Unmerged index stages have no single baseline.
    const match = /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t/.exec(entries[0]);
    if (!match || entries[0].slice(match[0].length) !== path) return undefined;
    // Raw blobs do not represent the displayed text when clean/smudge or encoding filters apply.
    const attrs = (await git("check-attr", "-z", "filter", "working-tree-encoding", "--", path))
      .toString("utf8")
      .split("\0");
    for (let index = 2; index < attrs.length; index += 3) {
      if (attrs[index] !== "unspecified" && attrs[index] !== "unset") return undefined;
    }
    const size = Number((await git("cat-file", "-s", match[2])).toString("utf8").trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EDIT_BYTES) return undefined;
    // The immutable object ID keeps this read consistent if another process stages during it.
    const bytes = await git("cat-file", "blob", match[2]);
    if (bytes.length !== size || bytes.includes(0)) return undefined;
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) return undefined;
    const text = raw.replace(/^\ufeff/, "").replaceAll("\r\n", "\n");
    return text.includes("\r") ? undefined : text;
  } catch {
    // Git/index errors must not prevent editing or manufacture all-added markers.
    return undefined;
  }
}
