import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { git } from "./git.ts";

export type Repository = { root: string; prefix: string };

const canonical = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;
const nul = (value: string) => value.split("\0").filter(Boolean);
const outside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path);
};

async function childPaths(repository: Repository) {
  const paths = new Set<string>();
  for (const entry of nul(await git(repository.root, ["ls-files", "--stage", "-z"]))) {
    const match = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
    if (match) paths.add(match[1]);
  }
  // A synthetic worktree index would turn an untracked embedded repository into a
  // gitlink. Find it first so its worktree is never omitted from the checkpoint.
  for (const path of nul(await git(repository.root, [
    "ls-files", "--others", "--exclude-standard", "--directory", "-z",
  ]))) {
    const absolute = resolve(repository.root, path), info = await stat(absolute).catch(() => undefined);
    let candidate = info?.isDirectory() ? absolute : dirname(absolute);
    while (candidate !== repository.root && !outside(repository.root, candidate)) {
      const physical = await realpath(candidate),
        topLevel = await realpath(await git(physical, ["rev-parse", "--show-toplevel"]));
      if (canonical(physical) === canonical(topLevel)) {
        paths.add(relative(repository.root, physical).replaceAll("\\", "/"));
        break;
      }
      candidate = dirname(candidate);
    }
  }
  return paths;
}

export async function discoverRepositories(cwd: string): Promise<Repository[]> {
  const workspace = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const repositories: Repository[] = [{ root: workspace, prefix: "" }];
  const queue = [{ repository: repositories[0], ancestors: new Set([canonical(workspace)]) }];
  const physicalRoots = new Set([canonical(workspace)]), prefixes = new Set([""]);

  for (let index = 0; index < queue.length; index++) {
    const { repository, ancestors } = queue[index];
    for (const path of await childPaths(repository)) {
      let childRoot: string;
      try {
        childRoot = await realpath(resolve(repository.root, path));
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (outside(workspace, childRoot))
        throw Error(`Nested repository escapes workspace: ${path}`);
      const topLevel = await realpath(await git(childRoot, ["rev-parse", "--show-toplevel"])),
        rootKey = canonical(childRoot);
      if (canonical(topLevel) !== rootKey) continue;
      if (ancestors.has(rootKey)) throw Error(`Nested repository cycle: ${path}`);
      if (physicalRoots.has(rootKey)) throw Error(`Duplicate nested repository: ${path}`);
      if (physicalRoots.size >= 100)
        throw Error("pi-timeline nested repository limit exceeded");
      const prefix = repository.prefix ? `${repository.prefix}/${path}` : path;
      if (prefixes.has(prefix)) continue;
      physicalRoots.add(rootKey);
      prefixes.add(prefix);
      const child = { root: childRoot, prefix };
      repositories.push(child);
      queue.push({ repository: child, ancestors: new Set([...ancestors, rootKey]) });
    }
  }
  return repositories;
}
