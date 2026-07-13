# pi-verify

Bounded project verification for [Pi](https://pi.dev).

`verify({ scope: "changed" | "project", checks?: string[] })` detects existing checks from `package.json` scripts, configured Ruff/Mypy/Pytest sections in `pyproject.toml`, `Cargo.toml`, `go.mod`, and explicit Makefile targets. When root declares no checks, immediate child packages are discovered in stable name order. It never installs dependencies or invents project-specific commands. At most six checks run sequentially; omitted check IDs are reported. Pass up to six IDs through `checks` for explicit selection. Each check has a five-minute timeout. Execution stops on first failure. Returned output keeps last 160 lines/12 KiB per command.

`changed` skips verification when Git reports a clean worktree. `project` always runs detected checks. Child-package commands execute inside their package directory.

Use after edits before completion. Verify publishes versioned `pi-verify:lifecycle` and `pi-verify:result` events containing bounded check metadata and a worktree identity; it also stores a log-free `pi-verify-result` session entry. Focus, Continuity, Timeline, Advisor, and Scout can consume this metadata. Clean worktrees are reported as `clean`, not falsely treated as verified. Extensions execute with full user permissions.
