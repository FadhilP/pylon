# pi-continuity

Opt-in planning, structured clarification, visible todos, external workspace memory, and compact ephemeral context for [Pi](https://pi.dev).

Its boundary-aware deterministic compaction and bounded session recall are inspired by [pi-blackhole](https://github.com/k0valik/pi-blackhole), while remaining Continuity-owned and using Pi's public session and compaction lifecycle APIs.

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

This installs the complete Pylon bundle, including pi-continuity. Run `/reload` after installation.

## Command Reference

Commands:

- `/plan [goal|approve|approve-current|review|deny <feedback>|cancel|status]`
- `/continuity [status|planner|executor] [provider/model[:thinking]|reset]`
- `/todos`
- `/memory [status]|on|off|show|owners|backups|compact|forget <key>|forget [user|project] <key>|forget project|forget suspect|forget owner <id>`

The dedicated `memory` tool uses `memory list|add|replace|remove`. Its read-only `list` action shows the current user/project owner's exact `scope/key` facts, transient applicability status and reason, and pending candidates for duplicate avoidance, replacement, or evidence-based removal.

The sequential, read-only `continuity_recall` tool searches bounded historical evidence from the current session. Execution scope is the default; explicit lineage scope includes pre-handoff active ancestry, and explicit all scope includes validated sibling branches. Text recall excludes thinking, tool arguments/results, and unrelated custom messages. Recall collects only enough matches for the requested eight-result page plus one lookahead match; its output and tool details report whether more matches are available instead of scanning for an exact total. Result records keep compact entry/role/time source addresses while the session ID appears once in the header. File-result expansion requires exact in-scope entry IDs and returns only bounded, credential-redacted evidence already stored by Pi; it never reads workspace files or creates session or memory entries.

## Planning

### When Planning Starts

Plan mode starts only through explicit `/plan`; natural-language keywords and `continuity_update set_plan` cannot activate the gate. Outside `/plan`, durable coordination is selective: the model uses `continuity_update set_plan` for risky or long multi-phase work, handoffs/background jobs, and likely blockers. Straightforward read-only work and one-shot local fixes may skip it. When useful, `set_plan` creates an internal executing todo list, automatically starts its first todo, and can be batched with the first independent read-only tools. Prefer 2–4 outcome-level todos by default; storage remains compatible with up to 12. Internal lists are not presented as structured user-facing plans.

## Plan Handoff, Execution, and Verification

### Plan Presentation

Planner and executor profiles are optional. Resetting either profile uses the main model and thinking level selected when `/plan` starts. Explicit plan mode selects the configured planner. Each stored plan revision requires at least one todo; missing summaries are derived from its todos. The planner uses `planSummary` as a compact executor handoff containing the approach, concrete paths or symbols, assumptions or unresolved gaps, and acceptance criteria. Continuity—not planner prose—presents every plan in the same `Goal`, `Approach`, `Constraints`, and numbered `Steps` structure. When that revision settles in TUI mode, including after clarification or requested changes, Continuity offers context-reset approval, current-context approval, or written revision feedback exactly once. Dismissing either approval or feedback input leaves the revision pending so it can be offered again after the next settled turn.

### Approval and Handoff

`/plan approve` keeps the visible session history but inserts a persisted execution boundary so the executor receives only the approved structured handoff and messages that follow it. A boundary is applied only when its supported version and run/timeline identity match the current work. When planning used Scout, the plan carries compact paths, symbols, line ranges, assumptions, and unresolved gaps rather than the raw report. The reset executor validates those anchors with narrow reads and calls Scout only for changed repository state, missing anchors, or unresolved gaps. `/plan approve-current` keeps existing model context. Both approval paths share the same executor selection, run metadata, persistence, and state transition; only context reset behavior differs. Non-TUI modes use slash commands. If a configured model is unavailable, Continuity stops instead of silently using another model.

### Todos and Tool Gates

The task widget shows all stored todos while the agent works and clears when the turn settles; todo descriptions are capped at 120 characters. `/todos` remains available afterward. Direct execution task lists do not restrict tools. Explicit plan mode permits only `read`, `grep` or `rg`, `find` or `fd`, `ls`, `continuity_update`, `memory` (list only), `repo_scout`, and `advisor`. Approval restores the pre-plan tool snapshot, including mutation tools such as `edit`, while respecting any remaining coordinated gate. Replanning preserves matching todo progress; completion requires every todo done. A todo update can atomically complete the current todo and start a validated pending `nextTodoId`, avoiding a second state-management turn. `action=todo` remains compatible with a single `todoId`; it also accepts up to 12 `todoIds` for atomic bulk completion. Bulk transitions only mark todos `done`, validate every ID and an optional next target before changing state, and save once. Nonterminal todo updates may accompany the next independent useful tool, but clarification remains isolated and state-sensitive ordering remains serial. Duplicate Continuity loads are ignored so stale planning handlers cannot keep tools blocked.

### Clarification

Structured clarification works during planning and active execution. Questions ask one concrete decision in plain language; short option descriptions explain outcomes or tradeoffs, with the recommended option first. During execution clarification is reserved for a new blocking user decision that cannot be safely inferred and must be the only tool call; the agent is instructed to ask only at a safe checkpoint and not repeat answered questions without new evidence. TUI and RPC modes show the option dialog. Print and JSON modes ask through the next prose response and block further tools for the remainder of that run. Cancelling an execution dialog requests cancellation of the current agent run without changing the work mode, todos, approval, or verification state.

### Verification

Read-only work can complete without Verify. Verification is a completion gate, not a separate todo by default: bulk-complete implementation todos before the final verification call. A sole remaining verification-only todo is marked done automatically when Verify passes. Run Verify in a tool-only turn with no user-facing prose, wait for its result, then write exactly one evidence-aware text-only final response; Continuity completes automatically. Never call an explicit completion tool. Keep every Continuity update tool-only and before final text; never narrate progress before calling it. This ordering prevents an early summary from being repeated when verification fails. A failed, cancelled, stale, or errored Verify run gets one caveated text-only final response that ends the assistant run with no subsequent tool call, leaving Continuity executing for later recovery. With Pylon, `bash` changes use one shared exact Git-backed worktree comparison per model turn; standalone Continuity retains per-call comparison. Unchanged commands add no verification debt; changed or indeterminate commands do. After a mutation-capable tool call, automatic completion requires current-worktree Verify state `passed`; `clean` or `no_checks` requires an explicit tool-only `allowUnverified` state acknowledgement before final text, which must disclose the limitation. Failed, cancelled, stale, error, and missing results never qualify. Mutation debt persists across user turns until verification passes. Heartbeat jobs carrying a valid `todoId` update that todo from running through completion or failure. `/plan review` records a shared-run `reviewer` phase and starts bounded implementation review.

## Memory and Storage

### Storage and Ownership

State lives under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-continuity`, never in the project. Per-session work files are protected by process leases. On session startup, Continuity compares them with Pi's persisted sessions and live leases, then removes work owned by deleted sessions; failed session discovery skips cleanup. Ephemeral-session work is removed on clean shutdown. Persistent memory, candidates, workspace metadata, and configuration are never part of this garbage collection. Experimental Memory V4 stores one shared collection under `memory-v4` with only `user` and `project` scopes. User facts are global. Git project identity is a hash of Git's canonical common directory; non-Git project identity falls back to the canonical workspace. When a repository moves, Continuity conservatively reassociates an unambiguous orphan owner only after a grace period and local commit/evidence proof, with a recoverable migration marker and backup. Remote URLs are never read or stored for identity. A capture commit and branch-at-capture are provenance only, never project identity.

### Writing and Compacting Memory

`memory add` may be text-only: Continuity derives a stable key, timestamp, workflow kind, conservative 0.5 confidence, source, project ownership, and trusted Git provenance. Prefer named stable keys for recurring commands and project conventions; `memory list` exposes exact existing keys before a duplicate-prone add, replace, or remove. `memory replace` and `memory remove` require an exact key; remove also requires a nonempty source/reason retained in the candidate audit record. Callers cannot set ownership, hashes, or Git provenance. Project memory mutations may provide up to five relative `evidencePaths`; Continuity resolves only regular, non-symlink, non-sensitive files below the canonical project root, bounds them to 256 KiB each/1 MiB total, and stores SHA-256 hashes (UTF-8 line endings are canonicalized so linked worktrees do not diverge under Git checkout settings). User facts cannot capture project evidence. Before its final response, the model assesses whether a durable candidate is warranted; this does not require creating one when no candidate is valid. Candidates compact automatically when each agent turn settles, and `/memory compact` triggers it immediately. Compaction identifies facts by scope + owner + key, treats `add` and `replace` as set operations, applies `remove`, clears processed candidates, and retains **30 global user facts plus 30 facts per project**. Under cap pressure active facts win over unchecked, unverifiable, then suspect facts; normal kind, confidence, and recency ranking follows. One preference receives a reserved prompt slot; other facts require lexical relevance. Prompt injection remains capped at three facts. `/memory off` disables injection for the current session without deleting or stopping memory storage; `/memory on` restores it. New sessions start with injection enabled.

### Applicability States

At injection and during `memory list`, all current-owner project facts are classified. Git execution or missing-object failures are `unverifiable`; a proven non-ancestor, changed evidence, or missing evidence is `suspect`; matching content evidence is `active`; and ancestry-only or provenance-free facts are `unchecked`. User facts are `unchecked` with reason `user memory`. Only active and unchecked facts are injected, so suspect facts cannot hide lower-ranked active facts. At most two hidden notices name suspect/unverifiable keys and ask the model to inspect current repository evidence; stale text is never injected. `memory list` includes stored text plus status and reason so the model can inspect current evidence before replacement or removal. Suspect status alone never justifies deletion. Suspect facts persist and can revive when ancestry/evidence passes. Ancestry or age alone never deletes memory.

### Inspecting and Removing Memory

`/memory` (or `/memory status`) reports only the current user/project owner's durable stored facts, currently visible active/unchecked facts, and pending candidates; pending candidates normally compact at settlement. `/memory show` displays current user/project facts with transient status, reason, and concise provenance. The web Memory tab separates editable project facts from read-only global user facts. `/memory forget suspect` confirms and reclassifies under lock before deleting only currently suspect project facts (never unverifiable ones). `/memory owners` lists owner IDs and counts; `/memory forget owner <id>` confirms removal of that exact owner's facts and candidates. `/memory backups` lists reset backups. Key forget defaults to the current project; specify `user` or `project` to target one scope explicitly. Continuity caches each workspace's last Git project owner so a transient Git failure exposes existing facts as unverifiable instead of silently switching owners.

See [High-Precision Automatic Memory Extraction Plan](docs/high-precision-automatic-memory-extraction.md) for the candidate-only automatic extraction proposal.

### File Integrity and Run Metadata

Memory and candidate files have explicit V4 schemas. Unsupported V4 files are renamed to `*.reset-unsupported-*` backups and replaced with empty V4 state. Malformed individual V4 records are dropped while valid records remain. Writes use unique temporary files and short cross-process locks. Pi owns sessions and decides when compaction runs; Continuity supplies one deterministic `session_before_compact` result for active work. It retains the latest scoped request and valid tool ordering, rejects summaries from other run/timeline boundaries, excludes pre-handoff planning context, redacts credential-like text, and stores versioned boundary metadata. Explicit planner, executor, and reviewer phases carry versioned `pylon-run` custom entries. Each plan has a unique `runId`; later plans inherit its `timelineId`, allowing consumers such as pi-timeline to keep one history across execution boundaries and older child sessions.

## Security and Limitations

Extensions execute with full user permissions. V1 has no branch-aware active work, shell in plan mode, cloud sync, or structured clarification dialogs in print or JSON modes; those modes use a prose question instead.
