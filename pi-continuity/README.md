# pi-continuity

Opt-in planning, structured clarification, visible todos, external workspace memory, and compact ephemeral context for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-continuity. Run `/reload` after installation.

## Usage

Commands:

- `/plan [goal|approve|approve-current|review|deny <feedback>|cancel|status]`
- `/continuity [status|planner|executor] [provider/model[:thinking]|reset]`
- `/todos`
- `/memory status|show|compact|forget <key>|forget workspace`

Plan mode starts only through explicit `/plan`; natural-language keywords and `continuity_update set_plan` cannot activate the gate. For ordinary non-trivial multi-step work, the model calls `continuity_update set_plan` directly to create an executing todo list without requiring `/plan` or approval.

## Planning and Execution

Planner and executor profiles are optional. Resetting either profile uses the main model and thinking level selected when `/plan` starts. Explicit plan mode selects the configured planner. When a stored plan settles in TUI mode, Continuity offers fresh-session approval, current-session approval, or written revision feedback.

`/plan approve` creates a child Pi session containing only the approved structured work handoff. `/plan approve-current` keeps existing context. Both select the executor profile before execution. Non-TUI modes use slash commands. If a configured model is unavailable, Continuity stops instead of silently using another model.

The task widget shows all stored todos while the agent works and clears when the turn settles; todo descriptions are capped at 120 characters. `/todos` remains available afterward. Direct execution task lists do not restrict tools. Explicit plan mode permits only `read`, `grep` or `rg`, `find` or `fd`, `ls`, `continuity_update`, `repo_scout`, and `advisor`. Approval restores only tools Continuity removed. Replanning preserves matching todo progress; completion requires every todo done.

Execution completion requires current-worktree Verify state `passed`. `clean` or `no_checks` requires explicit `allowUnverified`. Failed, cancelled, stale, error, and missing results never qualify. Mutation tool calls invalidate prior verification. Heartbeat jobs carrying a valid `todoId` update that todo from running through completion or failure. `/plan review` records a shared-run `reviewer` phase and starts bounded implementation review.

## Memory and Storage

State lives under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-continuity`, never in the project. Memory candidates can be stored with or without active plan work and compact automatically when each agent turn settles. `/memory compact` triggers immediate compaction without a model call.

Compaction keeps one fact per stable key, treats `add` and `replace` as set operations, applies `remove`, clears processed candidates, and retains up to 80 facts with preferences and warnings favored. Preferences always enter context; other facts enter only when lexically relevant. Compacted facts survive reload and can surface from the nearest parent workspace.

Persisted work and memory are schema-validated; malformed files are quarantined. Writes use unique temporary files and short cross-process locks. Pi owns sessions and compaction. Explicit plan and executor sessions carry versioned `pi-conductor-run` custom entries with one shared `runId`, allowing consumers such as pi-timeline to group them without detecting whether Continuity is installed.

## Security and Limitations

Extensions execute with full user permissions. V1 has no branch-aware active work, shell in plan mode, cloud sync, or interactive clarification in print or JSON modes. Planner and executor handoff requires a persisted Pi session.
