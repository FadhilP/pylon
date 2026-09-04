# pi-verify

Bounded project verification after Pi edits.

## Install and use

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Pylon Web exposes package status and `verify` tool exposure; Verify behavior itself is controlled by effective project/session policy.

```ts
verify({ scope: "changed" | "project", checks?: string[] })
```

Use `changed` after edits; it skips checks when Git is clean. Use `project` to run detected checks even when clean. Child-package checks run in their package directory. Call Verify in a tool-only assistant turn, wait for the result, then give exactly one evidence-aware final response. A failed, cancelled, stale, or errored result blocks more tool calls in that run; the next user input/session starts fresh.

## What Verify runs

Verify first runs bounded `git diff --check HEAD --` hygiene in dirty Git worktrees and returns bounded `git status --short` visibility for untracked files. It detects declared/configured/standard npm, Composer, Deno, Python (Ruff/Mypy/Pytest/Tox/Nox), Rust, Go, Maven/credible Gradle, .NET, Make/Just, Ruby, Dart/Flutter, Haskell, Elixir, Swift, Scala, OCaml, Clojure, Gleam, Crystal, Nix, Erlang, and Zig checks; Maven/Gradle wrappers are preferred.

If the root declares no checks, it examines immediate non-hidden source directories in stable order without recursion, skipping common generated/vendor directories. At most six checks run; same-directory checks are sequential and independent directories run up to four at once. Pass `checks` only as up to six exact IDs supplied by the user or verification catalog, never guessed labels. Each check times out after five minutes. A failure prevents new checks while already-running ones finish. Hygiene output is capped at 80 lines/8 KiB and each check at 160 lines/12 KiB; omitted IDs are reported.

Verify does not install dependencies or invent project-specific commands. Detected build tools may restore their own dependencies. A clean worktree is `clean`, not falsely “verified.” Detected checks run with your user permissions.

## Integrations

Verify emits bounded versioned `pi-verify:lifecycle` and `pi-verify:result` events with worktree identity, and stores a log-free `pi-verify-result` session entry. Focus, Continuity, Timeline, Advisor, and Scout can consume this metadata.
