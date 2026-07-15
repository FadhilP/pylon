# pi-grunt

Sequential delegated implementation worker for Pi. Grunt uses a separately configured worker model in an isolated temporary Git worktree while the main model waits. It can implement a compact slice or an entire non-difficult change.

## Install

```sh
pi install /absolute/path/to/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-grunt. Run `/reload` after installation.

## Configure

```text
/grunt provider/model-id
/grunt status
/grunt reset
/grunt disable
```

Without a configured model, Grunt uses the current main model. The main model must select either `medium` or `high` thinking on every `grunt` call. Unsupported levels are clamped by Pi to model capabilities.

`PI_GRUNT_TIMEOUT_MS` overrides the 15-minute timeout, up to two hours.

## Routing

Use estimated changed LOC only as a soft guide:

- Small: under 50 LOC. Main model usually implements directly.
- Medium: 50–400 LOC inclusive. Grunt is a good fit when handoff stays compact and validation is easy.
- Large: over 400 LOC. Grunt is strongly useful for mechanical work; use `high` thinking for semantic edge cases.
- Deep architectural change: main model owns architecture. Grunt may implement bounded, non-difficult slices.

Reasoning complexity, architectural coupling, handoff compactness, and validation ease override LOC. A tiny security or concurrency change may still be difficult.

Grunt calls are unlimited per original user prompt. Dependent slices remain sequential: invoke Grunt for one slice, inspect its applied changes, run focused verification, then invoke Grunt for the next slice. Do not issue dependent calls in one assistant response because later handoffs cannot incorporate earlier results.

Advisor remains optional. Use it at least once when delegated work follows consequential architecture, exposes new uncertainty, or needs recovery review.

## Behavior

`grunt({ task, thinking, suggestedPaths? })` starts one synchronous child Pi process. The child receives bounded redacted parent context and the built-in `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash` tools. `suggestedPaths` guides scope but is not an allowlist.

Grunt requires a Git repository with a `HEAD` commit. It creates a detached temporary worktree, mirrors the parent's current tracked and non-ignored untracked files, and commits that snapshot only on the detached worker branch. After successful completion, Grunt derives a binary patch, verifies that the parent's `HEAD` and dirty-file fingerprints remain unchanged, then applies the patch to the parent. Results report changed paths, pre-existing dirty files touched, changes outside suggested paths, and whether the patch was applied.

The worker must stop when it encounters architectural ownership, public API decisions, security-sensitive behavior, destructive migrations, conflicting requirements, or material scope expansion. It must not commit, stash, reset, clean, install dependencies, publish, or use network commands.

## Safety

Before launch, Grunt resolves the temporary worktree's Git top-level and verifies it differs from the parent. The child process is spawned with that worktree as its OS working directory, and results include isolation verification metadata. Worker patches are collected only from that worktree.

Blocked, aborted, timed-out, failed, stale, or unapplicable work never changes the parent worktree. When isolated edits exist, Grunt stores their unapplied patch under the Pi agent directory and reports its path. Successful patches are applied only after the stale-parent check. Temporary worktrees are always removed.

The timeout is 15 minutes unless `PI_GRUNT_TIMEOUT_MS` overrides it. The main model must inspect applied changes and run final verification before completion.

Worktree isolation protects the parent repository from ordinary worker edits; it is not a security sandbox. Pi extensions and child tools run with user permissions. Review package source before installation. Task/context text is sent to the selected model provider under that provider's terms and pricing.
