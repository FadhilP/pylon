import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
export async function preflight(cwd: string) {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]),
    bare = await git(root, ["rev-parse", "--is-bare-repository"]),
    head = await git(root, ["rev-parse", "HEAD"]);
  if (bare === "true") throw Error("Bare repositories unsupported.");
  if ((await git(root, ["ls-files", "-u"])).trim())
    throw Error("Unmerged index unsupported.");
  if ((await git(root, ["submodule", "status"])).trim())
    throw Error("Submodules unsupported.");
  const raw = await git(root, ["rev-parse", "--git-dir"]),
    gd = raw.startsWith("/") || /^[A-Za-z]:/.test(raw) ? raw : join(root, raw);
  for (const f of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
  ])
    if (existsSync(join(gd, f))) throw Error("Git operation in progress.");
  const unsafe = (
    await git(root, ["ls-files", "--others", "--exclude-standard"])
  )
    .split(/\r?\n/)
    .filter((p) =>
      /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials|id_rsa|id_ed25519|known_hosts)$|\.(pem|key|p12|pfx|keystore)$/i.test(
        p,
      ),
    );
  if (unsafe.length) throw Error(`Unsafe untracked path: ${unsafe[0]}`);
  return { root, head };
}
