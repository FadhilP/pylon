# pi-grunt

Sequential delegated implementation worker for Pi. Grunt uses a separately configured worker model while the main model waits. Isolated Git-worktree execution is default; manually enabled direct mode edits the current working directory. It can implement a compact slice or an entire non-difficult change.

## Installation

```sh
pi install /absolute/path/to/pylon
```

This installs the complete Pylon bundle, including pi-grunt. Run `/reload` after installation.

## Configuration

```text
/grunt provider/model-id
/grunt status
/grunt reset
/grunt isolated
/grunt direct
/grunt dynamic
/grunt disable
```

Grunt stays inactive until you select a model or run `/grunt reset`. Reset enables Grunt with the current main model and restores isolated mode. `/grunt direct` opts into direct execution; `/grunt isolated` switches back. `/grunt dynamic` chooses isolated mode when the current directory belongs to a Git worktree with a `HEAD` commit, otherwise direct mode. The selected mode persists in Grunt's global config and is shown by `/grunt status`. The main model must select either `medium` or `high` thinking on every `grunt` call. Unsupported levels are clamped by Pi to model capabilities.

Environment controls:

- `PI_GRUNT_TIMEOUT_MS`: wall-clock timeout; default 15 minutes, maximum two hours.
- `PI_GRUNT_MAX_TURNS`: maximum child turns before another turn is blocked; default 40.
- `PI_GRUNT_MAX_COST_USD`: maximum reported child cost before another turn is blocked; default `$2`.
- `PI_GRUNT_PARENT_CONTEXT_CHARS`: redacted parent-context budget; default `0` (disabled), maximum 12,000. Handoffs should be self-contained.

Workers have a fixed 262,144-token reported-context limit. After each assistant response, Grunt counts `totalTokens - cacheRead` when native totals are available, otherwise `input + output + cacheWrite`. Exceeding the limit terminates the child and leaves any isolated edits unapplied.

## Routing

Use estimated changed LOC only as a soft guide:

- Small: under 50 LOC. Main model usually implements directly.
- Medium: 50–400 LOC inclusive. Grunt is a good fit when handoff stays compact and validation is easy.
- Large: over 400 LOC. One Grunt call is appropriate for mechanical work.
- Large non-mechanical change: decompose it into coherent sequential slices, preferably about 200–300 changed LOC or less per semantic slice. Delegate the whole change only when behavior is simple and validation is decisive.
- Deep architectural change: main model owns architecture. Grunt may implement bounded, non-difficult slices.

Reasoning complexity, architectural coupling, handoff compactness, and validation ease override LOC. A tiny security or concurrency change may still be difficult.

Provide `suggestedPaths` whenever the main model has reliable implementation anchors from its existing context or repository evidence. Use the narrowest useful files or directories. Omit paths rather than guessing stale or uncertain locations; they guide discovery and scope but are not an allowlist.

Grunt calls are unlimited per original user prompt. Dependent slices remain sequential: invoke Grunt for one slice, inspect its applied changes, run focused verification, then invoke Grunt for the next slice. Do not issue dependent calls in one assistant response because later handoffs cannot incorporate earlier results.

Advisor remains optional. Use it at least once when delegated work follows consequential architecture, exposes new uncertainty, or needs recovery review.

After any Grunt result, the main model owns recovery. It should inspect completed changes or a partial patch artifact, then fix small/local defects and finish small remaining work directly. It should not spawn another worker merely to verify or repair the previous worker. Re-delegation is reserved for remaining work that is still medium or large, self-contained, easy to validate, and likely cheaper than main-model completion.

## Behavior

`grunt({ task, thinking, suggestedPaths? })` starts one synchronous child Pi process. The child receives the built-in `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash` tools. Optional parent context is bounded and redacted. `suggestedPaths` guides scope but is not an allowlist.

In isolated mode, Grunt requires a Git repository with a `HEAD` commit. It creates a detached temporary worktree, then mirrors only dirty/deleted tracked paths and non-ignored untracked paths because Git already checked out clean tracked files. Checkout and baseline-commit hooks are disabled. After normal completion, Grunt derives a binary patch against the immutable baseline commit, verifies that the parent's `HEAD` and dirty-file fingerprints remain unchanged, rechecks immediately before integration, then applies the patch. Worker commits remain included. Successful results omit changed-path and worker-report duplication; the main model inspects authoritative Git state. Non-completed results retain changed paths, scope diagnostics, and the worker report for recovery. Isolation setup failures throw tool errors, so Pi marks them as errors in the TUI.

In direct mode, Grunt runs in Pi's current working directory and works outside Git repositories. Edits happen immediately. Failure, timeout, cancellation, or a blocked report may leave partial changes. Direct mode provides no rollback, stale-parent check, patch artifact, or derived changed-path list.

Dynamic mode checks for a Git worktree and valid `HEAD` before each Grunt call. It then uses the existing isolated or direct path; resolved mode is shown in tool output. If isolation setup later fails, dynamic mode falls back to direct execution and reports the setup failure. Explicit isolated mode still throws.

Ignored dependency directories such as `node_modules`, `.venv`, and `venv` are not copied. When present in the parent but unavailable to the worker, Grunt tells the worker to skip checks requiring them instead of installing or repeatedly probing for them.

### Worker context

The worker receives:

- Grunt's fixed worker system instructions.
- The exact `task` handoff.
- Optional `suggestedPaths`, explicitly marked as guidance rather than an allowlist.
- A note listing detected ignored dependency directories unavailable in the worktree.
- Optional redacted parent conversation context when `PI_GRUNT_PARENT_CONTEXT_CHARS` is greater than `0`. This uses at most the latest 10 user/assistant text or summary entries, caps each at 1,200 characters, removes tool payloads, applies pattern-based secret redaction, then enforces the configured total character limit.
- Tool results generated after the worker chooses to inspect or execute something.

The isolated repository snapshot is available on disk but is not inserted into the model prompt. Extensions, skills, prompt templates, context files, and persistent child sessions are disabled. Parent conversation context is disabled by default.

The worker must stop when it encounters architectural ownership, public API decisions, security-sensitive behavior, destructive migrations, conflicting requirements, or material scope expansion. It must not commit, stash, reset, clean, install dependencies, publish, or use network commands.

## Safety

In isolated mode, Grunt resolves the temporary worktree's Git top-level and verifies it differs from the parent. The child process is spawned with that worktree as its OS working directory, and results include isolation verification metadata. Worker patches are collected only from that worktree. Direct mode intentionally skips these guarantees and is labeled `DIRECT` in status and tool output.

Blocked, aborted, timed-out, budget-limited, output-limited, failed, stale, or unapplicable work never changes the parent worktree. Only a normal model `stop` can integrate changes. When isolated edits exist, Grunt stores their unapplied patch under the Pi agent directory and reports its path. Successful patches are applied only after the stale-parent checks. Same-repository transactions are queued through cleanup; independent repositories may run independently. Cleanup failures are warnings and never disguise an already-applied result.

Timeout, turn, reported-cost, and reported-context limits bound runaway workers. Token, turn, and cost limits are checked after each paid model response, so they prevent another turn rather than undoing cost already incurred. The main model must inspect applied changes and run final verification before completion.

Worktree isolation protects the parent repository from ordinary worker edits; it is not a security sandbox. Pi extensions and child tools run with user permissions. Review package source before installation. Task/context text is sent to the selected model provider under that provider's terms and pricing.
