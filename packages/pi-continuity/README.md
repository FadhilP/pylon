# pi-continuity

Opt-in planning, structured clarification, visible todos, external workspace memory, and compact ephemeral context for [Pi](https://pi.dev).

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-continuity. Run `/reload` after installation.

## Usage

Commands:

- `/plan [goal|approve|approve-current|review|deny <feedback>|cancel|status]`
- `/continuity [status|planner|executor] [provider/model[:thinking]|reset]`
- `/todos`
- `/memory status|on|off|show|owners|backups|compact|forget <key>|forget [user|project] <key>|forget project|forget suspect|forget owner <id>`

Plan mode starts only through explicit `/plan`; natural-language keywords and `continuity_update set_plan` cannot activate the gate. For ordinary non-trivial multi-step work, the model calls `continuity_update set_plan` directly to create an internal executing todo list, automatically start its first todo, and avoid requiring `/plan` or approval. That internal list is not presented as a structured user-facing plan.

## Planning and Execution

Planner and executor profiles are optional. Resetting either profile uses the main model and thinking level selected when `/plan` starts. Explicit plan mode selects the configured planner. Each stored plan revision requires at least one todo; missing summaries are derived from its todos. Continuity—not planner prose—presents every plan in the same `Goal`, `Approach`, `Constraints`, and numbered `Steps` structure. When that revision settles in TUI mode, including after clarification or requested changes, Continuity offers fresh-session approval, current-session approval, or written revision feedback exactly once.

`/plan approve` creates a child Pi session containing only the approved structured work handoff. When planning used Scout, the plan carries compact paths, symbols, line ranges, assumptions, and unresolved gaps rather than the raw report. The fresh executor validates those anchors with narrow reads and calls Scout only for changed repository state, missing anchors, or unresolved gaps. `/plan approve-current` keeps existing context. Both select the executor profile before execution. Non-TUI modes use slash commands. If a configured model is unavailable, Continuity stops instead of silently using another model.

The task widget shows all stored todos while the agent works and clears when the turn settles; todo descriptions are capped at 120 characters. `/todos` remains available afterward. Direct execution task lists do not restrict tools. Explicit plan mode permits only `read`, `grep` or `rg`, `find` or `fd`, `ls`, `continuity_update`, `repo_scout`, and `advisor`. Approval restores the pre-plan tool snapshot, including mutation tools such as `edit`, while respecting any remaining coordinated gate. Replanning preserves matching todo progress; completion requires every todo done. A todo update can atomically complete the current todo and start a validated pending `nextTodoId`, avoiding a second state-management turn. Duplicate Continuity loads are ignored so stale planning handlers cannot keep tools blocked.

Structured clarification works during planning and active execution. Questions ask one concrete decision in plain language; short option descriptions explain outcomes or tradeoffs, with the recommended option first. During execution clarification is reserved for a new blocking user decision that cannot be safely inferred and must be the only tool call; the agent is instructed to ask only at a safe checkpoint and not repeat answered questions without new evidence. TUI and RPC modes show the option dialog. Print and JSON modes ask through the next prose response and block further tools for the remainder of that run. Cancelling an execution dialog requests cancellation of the current agent run without changing the work mode, todos, approval, or verification state.

Read-only work can complete without Verify. `bash` compares exact Git-backed worktree fingerprints before and after execution, so unchanged commands add no verification debt; changed or indeterminate commands do. After a mutation-capable tool call, execution completion requires current-worktree Verify state `passed`; `clean` or `no_checks` requires explicit `allowUnverified`. Failed, cancelled, stale, error, and missing results never qualify. Mutation debt persists across user turns until verification passes. Heartbeat jobs carrying a valid `todoId` update that todo from running through completion or failure. `/plan review` records a shared-run `reviewer` phase and starts bounded implementation review.

## Memory and Storage

State lives under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-continuity`, never in the project. Experimental Memory V4 stores one shared collection under `memory-v4` with only `user` and `project` scopes. User facts are global. Git project identity is a hash of Git's canonical common directory; non-Git project identity falls back to the canonical workspace. Remote URLs are never stored. A capture commit and branch-at-capture are provenance only, never project identity.

`memory_candidate add` may be text-only: Continuity derives a stable key, timestamp, workflow kind, conservative 0.5 confidence, source, project ownership, and trusted Git provenance. `replace` and `remove` require an exact key; remove also requires a nonempty source/reason retained in the candidate audit record. Callers cannot set ownership, hashes, or Git provenance. Project memory mutations may provide up to five relative `evidencePaths`; Continuity resolves only regular, non-symlink, non-sensitive files below the canonical project root, bounds them to 256 KiB each/1 MiB total, and stores SHA-256 hashes (UTF-8 line endings are canonicalized so linked worktrees do not diverge under Git checkout settings). User facts cannot capture project evidence. Candidates compact automatically when each agent turn settles, and `/memory compact` triggers it immediately. Compaction identifies facts by scope + owner + key, treats `add` and `replace` as set operations, applies `remove`, clears processed candidates, and retains **30 global user facts plus 30 facts per project**. Under cap pressure active facts win over unchecked, unverifiable, then suspect facts; normal kind, confidence, and recency ranking follows. One preference receives a reserved prompt slot; other facts require lexical relevance. Prompt injection remains capped at three facts. `/memory off` disables injection for the current session without deleting or stopping memory storage; `/memory on` restores it. New sessions start with injection enabled.

At injection, all current-owner project facts are classified before final relevance selection. Git execution or missing-object failures are `unverifiable`; a proven non-ancestor, changed evidence, or missing evidence is `suspect`; matching content evidence is `active`; and ancestry-only or provenance-free facts are `unchecked`. Only active and unchecked facts are injected, so suspect facts cannot hide lower-ranked active facts. At most two hidden notices name suspect/unverifiable keys and ask the model to inspect current repository evidence; stale text is never injected. Suspect facts persist and can revive when ancestry/evidence passes. Ancestry or age alone never deletes memory.

`/memory show` displays current user/project facts with transient status, reason, and concise provenance. `/memory forget suspect` confirms and reclassifies under lock before deleting only currently suspect project facts (never unverifiable ones). `/memory owners` lists owner IDs and counts; `/memory forget owner <id>` confirms removal of that exact owner's facts and candidates. `/memory backups` lists reset backups. Key forget defaults to the current project; specify `user` or `project` to target one scope explicitly. Continuity caches each workspace's last Git project owner so a transient Git failure exposes existing facts as unverifiable instead of silently switching owners.

Memory and candidate files have explicit V4 schemas. On first V4 use the prior `memory-v3` directory is atomically renamed to a `*.reset-unsupported-*` backup and V4 starts empty; there is no migration. Unsupported files are likewise renamed and replaced with empty V4 state. Malformed individual V4 records are dropped while valid records remain. Writes use unique temporary files and short cross-process locks. Pi owns sessions and compaction. Explicit plan, executor, and reviewer sessions carry versioned `pylon-run` custom entries. Each plan has a unique `runId`; later plans started from an existing pylon session inherit its `timelineId`, allowing consumers such as pi-timeline to keep one cross-session history without detecting whether Continuity is installed.

## Security and Limitations

Extensions execute with full user permissions. V1 has no branch-aware active work, shell in plan mode, cloud sync, or structured clarification dialogs in print or JSON modes; those modes use a prose question instead. Planner and executor handoff requires a persisted Pi session.
