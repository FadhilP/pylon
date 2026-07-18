# pi-verify

Bounded project verification for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-verify. Run `/reload` after installation.

## Usage

```ts
verify({ scope: "changed" | "project", checks?: string[] })
```

Use Verify after edits and before completion. `changed` skips verification when Git reports a clean worktree. `project` always runs detected checks. Child-package commands run inside their package directory.

## How It Works

Verify first runs bounded changed-set hygiene with `git diff --check HEAD --` for dirty Git worktrees and reports bounded `git status --short` data for untracked-file visibility. It broadly detects declared, configured, explicitly targeted, or standardized lifecycle checks: npm, Composer, and Deno scripts/tasks; Python Ruff, Mypy, Pytest, Tox, and Nox; Rust, Go, Maven, credible JVM Gradle projects, .NET, Make, Just, Ruby Rake, Dart/Flutter, and Haskell; plus Elixir, Swift, Scala, OCaml, Clojure, Gleam, Crystal, Nix, Erlang, and Zig project files. Maven and Gradle wrappers are preferred when available.

When the root declares no checks, immediate non-hidden source directories are checked with the same detection rules in stable name order; common generated and vendor directories are skipped, and discovery never recurses. At most six checks run sequentially; omitted check IDs are reported. Pass up to six IDs through `checks` for explicit selection. Each check has a five-minute timeout. Execution stops on first failure. Hygiene output is capped at 80 lines or 8 KiB; check output keeps 160 lines or 12 KiB.

Coverage is broad but intentionally limited to declared/configured/standard checks, rather than guessed framework commands. Verify does not issue dependency-install commands or invent project-specific commands; detected build tools may still restore their own dependencies. Clean worktrees are reported as `clean`, not falsely treated as verified.

## Integrations

Verify publishes versioned `pi-verify:lifecycle` and `pi-verify:result` events containing bounded check metadata and a worktree identity. It also stores a log-free `pi-verify-result` session entry. Focus, Continuity, Timeline, Advisor, and Scout can consume this metadata.

## Security and Limitations

Detected project checks execute with full user permissions.
