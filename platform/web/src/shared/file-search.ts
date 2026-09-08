export function validRelativePath(path: string): boolean {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return (
    path.length <= 500 &&
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/.test(normalized) &&
    !normalized.includes("\\") &&
    !normalized.includes("\0") &&
    !normalized.split("/").some(part => part === "." || part === ".." || part === "")
  );
}

/** One ranking for composer file suggestions and the search popup. */
export function rankFilePaths(paths: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return paths
    .flatMap(path => {
      if (!validRelativePath(path)) return [];
      const lower = path.toLowerCase();
      const name = (lower.endsWith("/") ? lower.slice(0, -1) : lower).split("/").at(-1)!;
      const rank = !needle
        ? 5
        : name === needle
          ? 0
          : name.startsWith(needle)
            ? 1
            : lower.split("/").some(part => part.startsWith(needle))
              ? 2
              : lower.startsWith(needle)
                ? 3
                : lower.includes(needle)
                  ? 4
                  : -1;
      return rank < 0 ? [] : [{ path, rank }];
    })
    .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
    .map(item => item.path);
}
