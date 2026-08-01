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

Call Verify in a tool-only assistant turn with no user-facing prose. Wait for its result, then write exactly one evidence-aware final response. This single ordering applies to passing and non-passing outcomes, preventing an early summary from being repeated after a failure. A failed, cancelled, stale, or errored result blocks further tool calls for the rest of that agent run; the next user input or session starts fresh.

## Verification Behavior

### Hygiene and Discovery

Verify first runs bounded changed-set hygiene with `git diff --check HEAD --` for dirty Git worktrees and reports bounded `git status --short` data for untracked-file visibility. Successful model output is compact (state, check IDs/count, duration, hygiene marker, and any capped IDs); full bounded diagnostics remain available for failures, metadata, session entries, and expanded TUI rendering. It broadly detects declared, configured, explicitly targeted, or standardized lifecycle checks: npm, Composer, and Deno scripts/tasks; Python Ruff, Mypy, Pytest, Tox, and Nox; Rust, Go, Maven, credible JVM Gradle projects, .NET, Make, Just, Ruby Rake, Dart/Flutter, and Haskell; plus Elixir, Swift, Scala, OCaml, Clojure, Gleam, Crystal, Nix, Erlang, and Zig project files. Maven and Gradle wrappers are preferred when available.

### Scheduling and Limits

When the root declares no checks, immediate non-hidden source directories are checked with the same detection rules in stable name order; common generated and vendor directories are skipped, and discovery never recurses. At most six checks run: checks sharing a working directory stay sequential, while independent child-package directories run concurrently with a limit of four. Omitted check IDs are reported. Omit `checks` by default; pass up to six exact IDs only when supplied by the user or verification catalog, never inferred from scripts or labels. Each check has a five-minute timeout. A failure prevents new checks from starting; already-running independent checks finish. Hygiene output is capped at 80 lines or 8 KiB; check output keeps 160 lines or 12 KiB.

### Scope Boundaries

Coverage is broad but intentionally limited to declared/configured/standard checks, rather than guessed framework commands. Verify does not issue dependency-install commands or invent project-specific commands; detected build tools may still restore their own dependencies. Clean worktrees are reported as `clean`, not falsely treated as verified.

## Integrations

Verify publishes versioned `pi-verify:lifecycle` and `pi-verify:result` events containing bounded check metadata and a worktree identity. It also stores a log-free `pi-verify-result` session entry. Focus, Continuity, Timeline, Advisor, and Scout can consume this metadata.

## Security and Limitations

Detected project checks execute with full user permissions.
