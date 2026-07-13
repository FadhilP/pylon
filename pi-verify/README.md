# pi-verify

Bounded project verification for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-verify. Run `/reload` after installation.

## Usage

```ts
verify({ scope: "changed" | "project", checks?: string[] })
```

Use Verify after edits and before completion. `changed` skips verification when Git reports a clean worktree. `project` always runs detected checks. Child-package commands run inside their package directory.

## How It Works

Verify first runs bounded changed-set hygiene with `git diff --check HEAD --` for dirty Git worktrees and reports bounded `git status --short` data for untracked-file visibility. It then detects existing checks from `package.json` scripts, configured Ruff, Mypy, or Pytest sections in `pyproject.toml`, `Cargo.toml`, `go.mod`, and explicit Makefile targets.

When the root declares no checks, immediate child packages are discovered in stable name order. At most six declared checks run sequentially; omitted check IDs are reported. Pass up to six IDs through `checks` for explicit selection. Each check has a five-minute timeout. Execution stops on first failure. Hygiene output is capped at 80 lines or 8 KiB; check output keeps 160 lines or 12 KiB.

Verify never installs dependencies or invents project-specific commands. Clean worktrees are reported as `clean`, not falsely treated as verified.

## Integrations

Verify publishes versioned `pi-verify:lifecycle` and `pi-verify:result` events containing bounded check metadata and a worktree identity. It also stores a log-free `pi-verify-result` session entry. Focus, Continuity, Timeline, Advisor, and Scout can consume this metadata.

## Security and Limitations

Detected project checks execute with full user permissions.
