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
- `/continuity [status|planner|executor|memoryReviewer|compactionReviewer] [provider/model[:thinking]|reset]`
- `/todos`
- `/memory [status]|on|off|show|migrate-v4|owners|backups|rollback|edit user <id>|edit project <id>|forget user <id>|forget project <id>|forget project`

The dedicated `memory` tool supports `list` and one batched `propose` call of at most two additions, replacements, or removals. User proposals require an exact active-branch quote; project contracts require bounded repository line ranges. Proposals are never durable until strict preflight, a configured tool-free Memory Reviewer, post-review validation, settlement, and any required Verify result all succeed.

The sequential, read-only `continuity_recall` tool searches bounded historical evidence from the current session. Execution scope is the default; explicit lineage scope includes pre-handoff active ancestry, and explicit all scope includes validated sibling branches. Explicit `project_sessions` scope searches the validated active branches of other persisted Pi sessions in registered workspaces with the same project owner (Git-backed when available); the current session is excluded, malformed or legacy sessions are skipped, and results are labeled as untrusted historical evidence. Text recall excludes thinking, tool arguments/results, and unrelated custom messages. Recall collects only enough matches for the requested eight-result page plus one lookahead match; its output and tool details report whether more matches are available instead of scanning for an exact total. Current-session records retain compact entry/role/time source addresses, while project-session records add a session ID and composite `sessionId:entryId` address. File-result expansion requires an exact in-scope entry ID for current-session scopes or composite address for `project_sessions` and returns only bounded, credential-redacted evidence already stored by Pi; it never reads workspace files or creates session or memory entries.

## Deterministic Compaction and Optional Review

Continuity intercepts manual `/compact` and automatic compaction. It always builds the canonical result deterministically: active Work uses the latest request plus authoritative goal, plan, todos, constraints, verification, and file activity; ordinary sessions use stable bounded transcript extraction. By default it retains approximately 25,000 recent raw tokens; **Continuity retained tokens** in Pylon package settings can set this from 1,000–50,000 and overrides Pi's `compaction.keepRecentTokens` only for Continuity-owned compactions. New compactions use a 20,000-character canonical budget and reserve at most 4,000 characters for supplemental excerpts. V1 and V2 Continuity compaction metadata remains readable; new entries use V3 structured metadata.

When an unfinished tool-using run crosses Pi's configured compaction threshold, Continuity compacts between tool batches and starts one hidden continuation turn from the checkpoint. It does not resume after a terminating tool batch, cancellation, newer or queued user input, session shutdown, or compaction failure. A single running model response or tool is never interrupted mid-execution.

A Compaction Reviewer is optional and disabled until `/continuity compactionReviewer provider/model[:thinking]` or the equivalent Pylon setting is configured. The reviewer receives only a bounded credential-redacted packet containing the canonical draft and entries that the selected cut will discard. It may return at most six exact source excerpts. Continuity validates source entry, role, category, exact text, duplication, provenance, and budget before rendering accepted excerpts in a clearly lower-authority section. Reviewer output cannot alter canonical records, Work, verification, ordering, or the cut point.

Reviewer timeout, provider failure, truncation, malformed output, or rejected candidates falls back to the deterministic result. A parent/session abort still cancels. `/compact <instructions>` uses the text only as reviewer selection focus and requires a configured Compaction Reviewer; plain `/compact` never requires one. Review adds a model request with corresponding provider cost and privacy exposure. Telemetry stores only bounded model, timing, usage, and candidate counts—never transcript text, quotes, focus instructions, paths, or source IDs.

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

Memory V5 is a durable notebook of future-facing rules, separate from Active Work and read-only `continuity_recall` history. Notes contain an opaque ID, scope/derived owner, trigger, guidance, authority, origin, bounded source addresses, revision, and timestamps. Confidence, fixed kinds, Git applicability states, the 30-fact cap, and unreviewed candidates are removed.

State is atomically replaced under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-continuity/memory-v5/state.json` with mode `0600`. A shared reviewed-operation ledger makes settlement idempotent. Storage permits up to 1,000 notes per owner and 2 MiB total; writes fail visibly rather than evicting notes. Retrieval lexically matches trigger, guidance, identifiers, and related paths, then injects at most two complete `Memory: When …` rules within a bounded prompt budget. Prompt and active-work intent are scored separately, stored plans trigger another bounded retrieval, and newly matched rules defer consequential `bash`, `edit`, `write`, `grunt`, or `heartbeat_start` actions once so the model can reconsider before retrying.

### Reviewer-gated proposals

Configure a dedicated reviewer with `/continuity memoryReviewer provider/model[:thinking]` or Pylon settings. There is no fallback model. Preflight derives ownership, validates target revisions, resolves exact user quotes, reads regular non-sensitive repository ranges below the canonical project root, bounds evidence to three ranges/120 lines per proposal, hashes fresh excerpts, rejects secrets and strong duplicates, and sends only a bounded packet. The reviewer returns strict `accept`, `rewrite`, `merge`, or `reject` decisions. Truncated/malformed output, ungrounded paths or commands, stale targets/evidence, branch changes, provider failures, or missing credentials write nothing.

Approved operations are staged in `state.json`. At `agent_settled`, Continuity confirms the proposal result and quoted instruction remain on the active branch, rechecks evidence and target revisions, and commits the whole review once. Contracts citing files changed by the task require a current passing Verify result for the same worktree; terminal non-passing verification discards them, while missing/running verification leaves them pending.

### Direct editing

Users bypass model review. Pylon Web and interactive Pi can edit/delete both global user notes and current-project notes with ID+revision compare-and-set. Owners are always derived server-side. Direct edits become `user_instruction`/`user` notes and replace active provenance with a direct-edit source; global deletion requires explicit confirmation.

### V4 migration and recovery

Continuity detects V4 sources, creates permission-hardened raw backups, and records blocking status in a bounded `migration.json`. Pylon Web shows a confirmed migration action only while recoverable V4 data remains; if no reviewer is selected, it opens Continuity package settings first. When a Memory Reviewer is configured, startup automatically runs the reviewer-backed migration; `/memory migrate-v4` provides an explicit retry. Migration still preserves reviewer, credential screening, evidence, backup, journal, duplicate, ownership, and atomic-activation safeguards. Migration validates every legacy record and current evidence path, resumes bounded prepared batches, validates the complete merged V5 notebook, and activates every owner in one state replacement—never owner-by-owner. Imported notes retain legacy keys as migration source references; unresolved candidates are reported and never auto-apply. V4 files remain read-only and recoverable. `/memory backups` lists nested migration/reset backups; `/memory rollback` restores the pre-migration V5 notebook only while its activation revision is still current.

## Security and Limitations

Extensions execute with full user permissions. V1 has no branch-aware active work, shell in plan mode, cloud sync, or structured clarification dialogs in print or JSON modes; those modes use a prose question instead.
