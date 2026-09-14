import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { discoverRepositories, type Repository } from "./repositories.ts";

export type RepositoryState = Repository & { head: string };

async function inspect(repository: Repository): Promise<RepositoryState> {
  const { root } = repository;
  // Keep the directory last so paths containing newlines remain intact.
  const metadata = await git(root, ["rev-parse", "--is-bare-repository", "HEAD", "--absolute-git-dir"]);
  const fields = /^(true|false)\r?\n([a-f0-9]{40}|[a-f0-9]{64})\r?\n([\s\S]+)$/.exec(metadata);
  if (!fields) throw Error("Unable to inspect repository identity.");
  const [, bare, head, gd] = fields;
  if (bare === "true") throw Error("Bare repositories unsupported.");
  if ((await git(root, ["ls-files", "-u"])).trim())
    throw Error(`Unmerged index unsupported: ${repository.prefix || "."}`);
  for (const f of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"])
    if (existsSync(join(gd, f))) throw Error(`Git operation in progress: ${repository.prefix || "."}`);
  const unsafe = (await git(root, ["ls-files", "--others", "--exclude-standard"]))
    .split(/\r?\n/)
    .filter(p =>
      /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials|id_rsa|id_ed25519|known_hosts)$|\.(pem|key|p12|pfx|keystore)$/i.test(
        p,
      ),
    );
  if (unsafe.length)
    throw Error(`Unsafe untracked path: ${repository.prefix ? `${repository.prefix}/` : ""}${unsafe[0]}`);
  return { ...repository, head };
}

export async function preflight(cwd: string) {
  const repositories = await discoverRepositories(cwd),
    states = await Promise.all(repositories.map(inspect));
  return { root: states[0].root, head: states[0].head, repositories: states };
}
