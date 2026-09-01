# pi-grunt

A sequential delegated implementation worker for already-designed Pi tasks. It uses a separately configured model while the main model waits. Isolated Git worktrees are the default; direct mode deliberately edits the current directory.

## Install and configuration

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi afterward. Grunt settings, including allowed requested thinking levels, are available through Pylon Web.

| Command | Use |
| --- | --- |
| `/grunt` or `/grunt status` | Show configuration and run summary |
| `/grunt set provider/model-id` / `/grunt select` | Choose worker model |
| `/grunt mode isolated|direct|dynamic` | Select execution mode |
| `/grunt enable|disable|reset` | Enable, disable, or use current main model in isolated mode |

Grunt is inactive until configured or reset. Dynamic mode chooses isolated only in a Git worktree with `HEAD`; otherwise it chooses direct. Default allowed requested thinking levels are `medium` and `high` (provider capabilities still apply).
Configuration is stored at `<agent-dir>/pi-grunt/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden.

| Environment variable | Default and limit |
| --- | --- |
| `PI_GRUNT_TIMEOUT_MS` | 15 minutes; at most 2 hours |
| `PI_GRUNT_MAX_TURNS` | 40 turns |
| `PI_GRUNT_MAX_COST_USD` | $2 reported child cost |
| `PI_GRUNT_PARENT_CONTEXT_CHARS` | 0 (off); at most 12,000 redacted characters |

Workers also have a fixed 262,144-token reported-context limit. Limits stop future turns after a paid response; they cannot undo incurred cost.

## Delegate focused implementation slices

Use `grunt({ task, thinking, suggestedPaths?, targetedContext?, checkCommands? })` for mechanical multi-file work or bounded, already-designed changes with clear anchors and checks. Keep diagnosis, architecture/public API/security/concurrency choices, cross-cutting semantics, and small known-file changes in the main model. Give the worker the chosen design, exact anchors, constraints, non-goals, acceptance criteria, and up to eight existing focused checks. `targetedContext` is capped at 4,000 characters; suggested paths are guidance, not an allowlist.

Calls are unlimited per original prompt but dependent slices must be sequential: inspect and verify one result before handing off the next. The parent owns review, recovery, and final verification. Do not delegate simple repair or verification of a previous worker result. The worker must stop rather than decide architectural ownership, public API, security-sensitive behavior, destructive migrations, conflicting requirements, or material scope expansion.

## Execution modes and lifecycle

**Isolated mode** requires a Git repository with `HEAD`. Grunt creates a detached temporary worktree, copies parent dirty/deleted tracked files and non-ignored untracked files, and disables checkout/baseline hooks. On normal completion it derives a patch against the baseline, verifies parent `HEAD` and dirty fingerprints before and immediately before integration, then applies it. Worker commits are included. A setup failure is a tool error.

Only a normal child `stop` can integrate. Blocked, aborted, timed-out, budget/output-limited, failed, stale, or unapplicable isolated work never changes the parent. If isolated edits remain, their unapplied patch is stored under the Pi agent directory and reported for recovery. Successful output omits duplicate reports/changed paths because Git state is authoritative; incomplete outcomes retain diagnostics and worker report.

**Direct mode** runs in the current directory, including outside Git. Changes are immediate and a failure/cancellation may leave partial edits; there is no rollback, stale-parent check, patch artifact, or changed-path list. Dynamic mode falls back to direct if later isolation setup fails; explicit isolated mode does not.

Ignored dependency directories (`node_modules`, `.venv`, `venv`) are not copied. The worker is told to skip checks requiring them rather than install or repeatedly probe. It gets a replacement concise system prompt, the handoff, optional bounded redacted parent context, and built-in read/search/edit/shell tools. It loads its line-edit extension and Sieve; unrelated extensions, skills, templates, context files, and persistent child sessions are disabled.

## Safety and privacy

Isolation protects the parent from ordinary worker edits, not from code with your permissions. Direct runs are labeled `DIRECT`. The child must not commit, stash, reset, clean, install dependencies, publish, or use network commands. Task/context text is sent to the selected provider under its terms and pricing. Inspect applied changes and run final verification before completion.